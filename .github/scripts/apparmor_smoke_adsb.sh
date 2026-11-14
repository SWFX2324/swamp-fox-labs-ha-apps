#!/usr/bin/env bash
# Runs the real ADS-B Tracker image with its AppArmor profile enforced, the way
# Home Assistant does, against the synthetic feed in
# adsb_tracker/tests/fixtures/fake-adsbfi.js. Fails on any denied access, any
# endpoint that doesn't answer as expected, or errors in the app's log.
#
# Expects the image built as adsb-tracker:ci and the profile loaded.
set -euo pipefail

IMAGE=adsb-tracker:ci
NAME=adsb-apparmor
BASE=http://127.0.0.1:8099

data=$(mktemp -d)
chmod 777 "$data"
echo '{}' > "$data/options.json"

fail() { echo "FAIL: $*"; echo "--- app log"; docker logs "$NAME" 2>&1 | tail -50 || true; exit 1; }

# Host networking: requests from the runner come from 127.0.0.1, which the
# server accepts alongside Home Assistant's ingress proxy.
docker run -d --name "$NAME" --network host --security-opt apparmor=adsb_tracker \
  -e FAKE_ADSB_LOG=1 \
  -v "$data:/data" -v "$PWD/adsb_tracker/tests:/app/tests:ro" \
  "$IMAGE" node --require /app/tests/fixtures/fake-adsbfi.js /app/server.js > /dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/api/health" > /dev/null || fail "the server didn't start"
grep -q 'ingress only' <(docker logs "$NAME" 2>&1) || fail "the ingress-only rule isn't on inside the container"

for p in / /app.js /tracker.js /style.css /lib/leaflet/leaflet.js /lib/leaflet/leaflet.css /assets/topo-dark.svg /api/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' "$BASE$p")
  echo "$code $p"
  [[ "$code" == 200 ]] || fail "$p answered $code"
done

q() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "$BASE/api/query"; }
for body in '{"kind":"callsign","value":"AAL1920"}' '{"kind":"hex","value":"a17c95"}' '{"kind":"area","latitude":35.8,"longitude":-78.8,"radius":100}'; do
  code=$(q "$body"); echo "$code POST $body"
  [[ "$code" == 200 ]] || fail "query $body answered $code"
done
code=$(q '{"kind":"hex","value":"nothex"}')
[[ "$code" == 400 ]] || fail "an invalid search answered $code, not 400"

docker stop -t 20 "$NAME" > /dev/null

log=$(docker logs "$NAME" 2>&1)
if grep -E 'UNMOCKED|EACCES|EPERM|Error:' <<< "$log"; then fail "errors in the app's log"; fi

denied=$(sudo dmesg | grep 'apparmor="DENIED"' | grep adsb_tracker || true)
if [[ -n "$denied" ]]; then echo "$denied"; fail "AppArmor denied access"; fi

docker rm "$NAME" > /dev/null
echo "The image runs under its enforced AppArmor profile with nothing denied."
