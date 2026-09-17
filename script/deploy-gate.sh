#!/bin/sh
# Deploy ONE CollateralGate against an already-deployed feed.
#
# script/deploy.sh deploys the pair; this exists because the feed is live and must
# not be redeployed. A new gate is the only way to change maxAgeSeconds, since the
# gate holds it as an immutable — which is the point: a lender's staleness tolerance
# should not be silently editable by whoever holds a key.
#
#   export PATH="$HOME/.foundry/bin:$PATH"
#   cd /Volumes/D/statera
#   STATERA_CONFIRM=yes STATERA_FEED=0x... STATERA_MAX_AGE=7200 \
#     STATERA_MIN_WEI=500000000000000 sh script/deploy-gate.sh
#
# Guards, all checked before spending: confirmation, a key outside the repo at 0600
# that derives .deploykey.address, a balance floor, and a passing Solidity suite.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RPC="${STATERA_RPC:-https://rpc.xlayer.tech}"
FEED="${STATERA_FEED:-}"
MAX_AGE="${STATERA_MAX_AGE:-7200}"
KEY_FILE="${STATERA_KEY:-$HOME/.config/statera/deploykey}"
ADDR_FILE="$ROOT/.deploykey.address"
MIN_WEI="${STATERA_MIN_WEI:-500000000000000}" # 0.0005 OKB

if [ "${STATERA_CONFIRM:-no}" != "yes" ]; then
  echo "refusing: set STATERA_CONFIRM=yes to proceed"
  echo "this sends one real transaction on X Layer and spends OKB"
  exit 1
fi
[ -n "$FEED" ] || { echo "refusing: set STATERA_FEED to the live feed address"; exit 1; }

[ -f "$KEY_FILE" ] || { echo "missing $KEY_FILE"; exit 1; }
case "$(cd "$(dirname "$KEY_FILE")" && pwd)" in
  "$ROOT"|"$ROOT"/*) echo "refusing: $KEY_FILE is inside the repo; keys must live outside a git tree"; exit 1 ;;
esac
PERMS="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")"
[ "$PERMS" = "600" ] || { echo "refusing: $KEY_FILE has perms $PERMS, expected 600"; exit 1; }
[ -f "$ADDR_FILE" ] || { echo "missing $ADDR_FILE"; exit 1; }

PUBLISHER="$(cat "$ADDR_FILE")"
DERIVED="$(cast wallet address --private-key "$(cat "$KEY_FILE")" 2>&1 | grep -oE '^0x[0-9a-fA-F]{40}$' || true)"
[ -n "$DERIVED" ] || { echo "refusing: could not derive an address from the key"; exit 1; }
[ "$DERIVED" = "$PUBLISHER" ] || { echo "refusing: key derives $DERIVED but $ADDR_FILE says $PUBLISHER"; exit 1; }

# The feed must already exist, or the gate would point at nothing.
CODE="$(cast code "$FEED" --rpc-url "$RPC")"
[ "$CODE" != "0x" ] || { echo "refusing: no code at feed $FEED"; exit 1; }
FEED_PUB="$(cast call "$FEED" 'publisher()(address)' --rpc-url "$RPC")"
echo "feed      $FEED (publisher $FEED_PUB)"

BAL="$(cast balance "$PUBLISHER" --rpc-url "$RPC")"
echo "deployer  $PUBLISHER"
echo "balance   $BAL wei ($(cast from-wei "$BAL") OKB)"
if [ "$BAL" -lt "$MIN_WEI" ] 2>/dev/null; then
  echo "refusing: balance below $MIN_WEI wei"
  exit 1
fi

echo "running the Solidity suite before spending anything"
forge test >/dev/null
echo "  suite passed"

echo
echo "deploying CollateralGate (feed = $FEED, maxAgeSeconds = $MAX_AGE)"
forge create contracts/CollateralGate.sol:CollateralGate \
  --rpc-url "$RPC" \
  --private-key "$(cat "$KEY_FILE")" \
  --broadcast \
  --constructor-args "$FEED" "$MAX_AGE" | tee /tmp/statera-gate2-deploy.txt

GATE="$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/statera-gate2-deploy.txt | awk '{print $3}')"
[ -n "$GATE" ] || { echo "could not parse the gate address"; exit 1; }
echo "$GATE" > "$ROOT/.gate.address"
echo
echo "CollateralGate $GATE"
echo "(written to .gate.address as the current gate)"
