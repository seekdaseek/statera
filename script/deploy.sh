#!/bin/sh
# statera phase 3 deployment. NOT RUN IN PHASE 2.
#
# Deploys StateraFeed with the funded publisher, then CollateralGate pointed at it.
# Refuses to do anything unless STATERA_CONFIRM=yes is set, so an accidental
# invocation cannot spend. Run one block at a time and read the output.
#
#   export PATH="$HOME/.foundry/bin:$PATH"
#   cd /Volumes/D/statera
#   STATERA_CONFIRM=yes sh script/deploy.sh
#
# Preconditions, all checked below:
#   - the key exists outside the repo, 0600, and derives .deploykey.address
#   - that address holds enough OKB on X Layer
#   - the Solidity suite passes
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RPC="${STATERA_RPC:-https://rpc.xlayer.tech}"
MAX_AGE="${STATERA_MAX_AGE:-1800}"
# Secrets never live inside a git working tree. Default is outside the repo; override
# with STATERA_KEY, which must also be outside it (checked below).
KEY_FILE="${STATERA_KEY:-$HOME/.config/statera/deploykey}"
ADDR_FILE="$ROOT/.deploykey.address"
MIN_WEI="${STATERA_MIN_WEI:-20000000000000000}" # 0.02 OKB

if [ "${STATERA_CONFIRM:-no}" != "yes" ]; then
  echo "refusing to deploy: set STATERA_CONFIRM=yes to proceed"
  echo "this script sends two real transactions on X Layer and spends OKB"
  exit 1
fi

[ -f "$KEY_FILE" ] || { echo "missing $KEY_FILE"; exit 1; }
case "$(cd "$(dirname "$KEY_FILE")" && pwd)" in
  "$ROOT"|"$ROOT"/*) echo "refusing: $KEY_FILE is inside the repo; keys must live outside a git tree"; exit 1 ;;
esac
[ -f "$ADDR_FILE" ] || { echo "missing $ADDR_FILE"; exit 1; }

PERMS="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")"
[ "$PERMS" = "600" ] || { echo "refusing: $KEY_FILE has perms $PERMS, expected 600"; exit 1; }

PUBLISHER="$(cat "$ADDR_FILE")"
# Confirm the key on disk really is the address we are about to trust. Output is
# filtered so a malformed key cannot print itself into a log.
DERIVED="$(cast wallet address --private-key "$(cat "$KEY_FILE")" 2>&1 | grep -oE '^0x[0-9a-fA-F]{40}$' || true)"
[ -n "$DERIVED" ] || { echo "refusing: could not derive an address from the key"; exit 1; }
[ "$DERIVED" = "$PUBLISHER" ] || { echo "refusing: key derives $DERIVED but $ADDR_FILE says $PUBLISHER"; exit 1; }

BAL="$(cast balance "$PUBLISHER" --rpc-url "$RPC")"
echo "publisher $PUBLISHER"
echo "balance   $BAL wei ($(cast from-wei "$BAL") OKB)"
if [ "$BAL" -lt "$MIN_WEI" ] 2>/dev/null; then
  echo "refusing: balance below $MIN_WEI wei. Fund the address first."
  exit 1
fi

echo "running the Solidity suite before spending anything"
forge test >/dev/null
echo "  suite passed"

echo
echo "1/2 deploying StateraFeed (publisher = $PUBLISHER, immutable)"
forge create contracts/StateraFeed.sol:StateraFeed \
  --rpc-url "$RPC" \
  --private-key "$(cat "$KEY_FILE")" \
  --broadcast \
  --constructor-args "$PUBLISHER" | tee /tmp/statera-feed-deploy.txt

FEED="$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/statera-feed-deploy.txt | awk '{print $3}')"
[ -n "$FEED" ] || { echo "could not parse the feed address"; exit 1; }
echo "$FEED" > "$ROOT/.feed.address"
echo "  StateraFeed $FEED"

echo
echo "2/2 deploying CollateralGate (feed = $FEED, maxAge = ${MAX_AGE}s)"
forge create contracts/CollateralGate.sol:CollateralGate \
  --rpc-url "$RPC" \
  --private-key "$(cat "$KEY_FILE")" \
  --broadcast \
  --constructor-args "$FEED" "$MAX_AGE" | tee /tmp/statera-gate-deploy.txt

GATE="$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/statera-gate-deploy.txt | awk '{print $3}')"
echo "$GATE" > "$ROOT/.gate.address"
echo "  CollateralGate $GATE"

echo
echo "verifying what landed onchain"
echo "  feed.publisher      $(cast call "$FEED" 'publisher()(address)' --rpc-url "$RPC")"
echo "  feed.runCount       $(cast call "$FEED" 'runCount()(uint64)' --rpc-url "$RPC")"
echo "  gate.feed           $(cast call "$GATE" 'feed()(address)' --rpc-url "$RPC")"
echo "  gate.maxAgeSeconds  $(cast call "$GATE" 'maxAgeSeconds()(uint256)' --rpc-url "$RPC")"

echo
echo "done. First post (dry run first, then for real):"
echo "  STATERA_FEED=$FEED node dist/src/keeper.js"
echo "  STATERA_FEED=$FEED node dist/src/keeper.js --post"
echo
echo "Then install the cron line:"
echo "  */5 * * * * STATERA_FEED=$FEED /opt/statera/bin/keeper.sh --post >> /opt/statera/cron.log 2>&1"
