/**
 * Post-deployment verification.
 *
 * The public RPC is load balanced, so a read can land on a node that has not yet
 * seen the deployment: every check here polls eth_getCode until code exists before
 * reading anything else.
 *
 * The bytecode comparison masks immutable references. Both contracts embed
 * constructor arguments into their deployed bytecode (the publisher, and the gate's
 * feed and maxAge), so a byte-for-byte comparison against the artifact would always
 * fail. The artifact records where those windows are; this masks them in both sides,
 * compares the rest exactly, and then checks the immutable VALUES separately through
 * the contracts' own getters — which is a stronger check than comparing the raw
 * windows, because it proves the constructor wired them, not just that bytes landed.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, defineChain, parseAbi } from "viem";

const RPC = process.env["STATERA_RPC"] ?? "https://rpc.xlayer.tech";
const FEED = process.argv[2];
const GATE = process.argv[3];
if (!FEED || !GATE) throw new Error("usage: verify-deploy.mjs <feed> <gate>");

const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain: xlayer, transport: http(RPC) });

const FEED_ABI = parseAbi([
  "function publisher() view returns (address)",
  "function runCount() view returns (uint64)",
  "function lastEngineBlock() view returns (uint40)",
  "function GAP_TOLERANCE_BPS() view returns (int256)",
  "function MAX_REALISABLE_MULTIPLE() view returns (uint256)",
]);
const GATE_ABI = parseAbi([
  "function feed() view returns (address)",
  "function maxAgeSeconds() view returns (uint256)",
]);

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}${detail ? "  " + detail : ""}`);
  else { fails++; console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`); }
};

/** Poll until the address reports code. The RPC is load balanced; one node lagging is normal. */
async function waitForCode(addr, label, tries = 40) {
  for (let i = 1; i <= tries; i++) {
    let code = "0x";
    try {
      code = await pub.getCode({ address: addr }) ?? "0x";
    } catch { /* a node may error mid-rollout */ }
    if (code && code !== "0x") {
      console.log(`  ${label} code present after ${i} poll${i > 1 ? "s" : ""}: ${(code.length - 2) / 2} bytes`);
      return code;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label} still has no code at ${addr} after ${tries} polls`);
}

/** Zero out the immutable windows the artifact declares, in a hex string. */
function maskImmutables(hex, immutableReferences) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  let masked = 0;
  for (const refs of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      bytes.fill(0, start, start + length);
      masked += length;
    }
  }
  return { hex: "0x" + bytes.toString("hex"), masked };
}

function artifact(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  return {
    object: j.deployedBytecode.object,
    immutableReferences: j.deployedBytecode.immutableReferences ?? {},
  };
}

console.log(`verifying on ${RPC}`);
console.log(`chain id ${await pub.getChainId()}, head ${await pub.getBlockNumber()}\n`);

console.log("StateraFeed", FEED);
const feedCode = await waitForCode(FEED, "  feed");
const feedArt = artifact("out/StateraFeed.sol/StateraFeed.json");
{
  const a = maskImmutables(feedCode, feedArt.immutableReferences);
  const b = maskImmutables(feedArt.object, feedArt.immutableReferences);
  ok("deployed bytecode matches the build (immutables masked)", a.hex === b.hex, `${a.masked} immutable bytes masked, ${(feedCode.length - 2) / 2} bytes compared`);
}
const publisher = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "publisher" });
const runCount = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "runCount" });
const lastBlk = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "lastEngineBlock" });
const tol = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "GAP_TOLERANCE_BPS" });
const mult = await pub.readContract({ address: FEED, abi: FEED_ABI, functionName: "MAX_REALISABLE_MULTIPLE" });
const expectedPublisher = readFileSync(".deploykey.address", "utf8").trim();
ok("publisher is the funded key, immutably", publisher.toLowerCase() === expectedPublisher.toLowerCase(), publisher);
ok("feed starts empty", Number(runCount) === 0 && Number(lastBlk) === 0, `runCount ${runCount}, lastEngineBlock ${lastBlk}`);
ok("constants are the reviewed values", Number(tol) === 1 && Number(mult) === 2, `GAP_TOLERANCE_BPS ${tol}, MAX_REALISABLE_MULTIPLE ${mult}`);

console.log("\nCollateralGate", GATE);
const gateCode = await waitForCode(GATE, "  gate");
const gateArt = artifact("out/CollateralGate.sol/CollateralGate.json");
{
  const a = maskImmutables(gateCode, gateArt.immutableReferences);
  const b = maskImmutables(gateArt.object, gateArt.immutableReferences);
  ok("deployed bytecode matches the build (immutables masked)", a.hex === b.hex, `${a.masked} immutable bytes masked, ${(gateCode.length - 2) / 2} bytes compared`);
}
const gFeed = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "feed" });
const gAge = await pub.readContract({ address: GATE, abi: GATE_ABI, functionName: "maxAgeSeconds" });
ok("gate points at the deployed feed", gFeed.toLowerCase() === FEED.toLowerCase(), gFeed);
ok("gate max age is 1800s, matching the keeper heartbeat", Number(gAge) === 1800, `${gAge}s`);

console.log("");
console.log(fails === 0 ? "PASS  both deployments verified onchain" : `FAIL  ${fails} check(s) failed`);
process.exitCode = fails === 0 ? 0 : 1;
