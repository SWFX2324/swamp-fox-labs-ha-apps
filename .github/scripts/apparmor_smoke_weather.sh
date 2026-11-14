#!/usr/bin/env bash
# Runs the real Weather Observatory image with its AppArmor profile enforced, the way
# Home Assistant does, against the fake Home Assistant and weather services in
# weather_observatory/tests/fixtures/fake-world.js. Fails on any denied access, any
# endpoint that doesn't answer as expected, or errors in the app's log.
#
# Expects the image built as weather-observatory:ci and the profile loaded.
set -euo pipefail

IMAGE=weather-observatory:ci
NAME=weather-apparmor
BASE=http://127.0.0.1:8099

data=$(mktemp -d)
chmod 777 "$data"
echo '{}' > "$data/options.json"

fail() { echo "FAIL: $*"; echo "--- app log"; docker logs "$NAME" 2>&1 | tail -50 || true; exit 1; }

# Host networking: requests from the runner come from 127.0.0.1, which the
# server accepts alongside Home Assistant's ingress proxy.
docker run -d --name "$NAME" --network host --security-opt apparmor=weather_observatory \
  -e FAKE_WORLD=alerts \
  -v "$data:/data" -v "$PWD/weather_observatory/tests:/app/tests:ro" \
  "$IMAGE" node --require /app/tests/fixtures/fake-world.js /app/server.js > /dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/api/health" > /dev/null || fail "the server didn't start"
grep -q 'ingress only' <(docker logs "$NAME" 2>&1) || fail "the ingress-only rule isn't on inside the container"

for p in / /app.js /wxcore.js /style.css /lib/leaflet/leaflet.js /lib/leaflet/leaflet.css /assets/topo-dark.svg /api/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' "$BASE$p")
  echo "$code $p"
  [[ "$code" == 200 ]] || fail "$p answered $code"
done

# Every source answers through the fake services: Home Assistant (states,
# forecasts, history, sun) and the public ones (NWS, Open-Meteo, RainViewer).
state=$(curl -sf "$BASE/api/state") || fail "api/state didn't answer"
for k in weather hourly daily history sun alerts station air radar; do
  err=$(jq -r ".$k.error" <<< "$state")
  ok=$(jq -r "(.$k.data != null)" <<< "$state")
  echo "$k: data=$ok error=$err"
  [[ "$ok" == true && "$err" == null ]] || fail "$k didn't load"
done

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/refresh")
echo "$code POST api/refresh"
[[ "$code" == 200 ]] || fail "refresh answered $code"

# The Docker HEALTHCHECK (what the Supervisor's watchdog watches) must pass
# under the profile too.
for _ in $(seq 1 30); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [[ "$health" == healthy ]] && break
  sleep 2
done
echo "Health: $health"
[[ "$health" == healthy ]] || fail "the health check didn't pass: $(docker inspect -f '{{json .State.Health}}' "$NAME")"

docker stop -t 20 "$NAME" > /dev/null

log=$(docker logs "$NAME" 2>&1)
if grep -E 'UNMOCKED|EACCES|EPERM|Error:' <<< "$log"; then fail "errors in the app's log"; fi

denied=$(sudo dmesg | grep 'apparmor="DENIED"' | grep weather_observatory || true)
if [[ -n "$denied" ]]; then echo "$denied"; fail "AppArmor denied access"; fi

docker rm "$NAME" > /dev/null
echo "The image runs under its enforced AppArmor profile with nothing denied."
