#!/usr/bin/env bash
# Runs the real Mesh Hub image with its AppArmor profile enforced, the way Home
# Assistant does, against the simulated radios and public maps in
# mesh_hub/tests/fixtures (with-radios.js). Fails on any denied access, any
# endpoint that doesn't answer as expected, either radio not connecting, or
# errors in the app's log.
#
# Expects the image built as mesh-hub:ci and the profile loaded.
set -euo pipefail

IMAGE=mesh-hub:ci
NAME=mesh-apparmor
BASE=http://127.0.0.1:8099

data=$(mktemp -d)
chmod 777 "$data"
cat > "$data/options.json" <<'EOF'
{"meshtastic_host":"127.0.0.1","meshtastic_port":14403,"meshcore_host":"127.0.0.1","meshcore_port":15000,"allow_sending":true,"public_maps":true,"map_radius_km":100}
EOF

fail() { echo "FAIL: $*"; echo "--- app log"; docker logs "$NAME" 2>&1 | tail -50 || true; exit 1; }

# Host networking: requests from the runner come from 127.0.0.1, which the
# server accepts alongside Home Assistant's ingress proxy.
docker run -d --name "$NAME" --network host --security-opt apparmor=mesh_hub \
  -e HOME_LAT=34.0007 -e HOME_LON=-81.0348 \
  -v "$data:/data" -v "$PWD/mesh_hub/tests:/app/tests:ro" \
  "$IMAGE" node --require /app/tests/fixtures/with-radios.js /app/server.js > /dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/api/health" > /dev/null || fail "the server didn't start"
grep -q 'ingress only' <(docker logs "$NAME" 2>&1) || fail "the ingress-only rule isn't on inside the container"

for p in / /app.js /style.css /favicon.svg /lib/leaflet/leaflet.js /lib/leaflet/leaflet.css /assets/topo-dark.svg /api/health /api/state; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' "$BASE$p")
  echo "$code $p"
  [[ "$code" == 200 ]] || fail "$p answered $code"
done

# Both radios connect and sync, and the public maps load.
for _ in $(seq 1 30); do
  links=$(curl -s "$BASE/api/health")
  grep -q '"meshtastic":"connected"' <<< "$links" && grep -q '"meshcore":"connected"' <<< "$links" && break
  sleep 1
done
echo "Links: $links"
grep -q '"meshtastic":"connected"' <<< "$links" || fail "the Meshtastic radio didn't connect"
grep -q '"meshcore":"connected"' <<< "$links" || fail "the MeshCore radio didn't connect"
grep -q 'public nodes within' <(docker logs "$NAME" 2>&1) || fail "the public maps didn't load"

s() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "$BASE/api/send"; }
for body in '{"network":"meshtastic","chat":"ch:0","text":"smoke test"}' '{"network":"meshcore","chat":"ch:0","text":"smoke test"}'; do
  code=$(s "$body"); echo "$code POST $body"
  [[ "$code" == 200 ]] || fail "send $body answered $code"
done
code=$(s '{"network":"nope","chat":"ch:0","text":"x"}')
[[ "$code" == 400 ]] || fail "an invalid send answered $code, not 400"

# The Docker HEALTHCHECK (what the Supervisor's watchdog watches) must pass
# under the profile too.
for _ in $(seq 1 30); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [[ "$health" == healthy ]] && break
  sleep 2
done
echo "Health: $health"
[[ "$health" == healthy ]] || fail "the health check didn't pass: $(docker inspect -f '{{json .State.Health}}' "$NAME")"

# Messages are saved within a couple of seconds.
sleep 3
docker stop -t 20 "$NAME" > /dev/null
[[ -s "$data/messages.json" ]] || fail "messages weren't saved"

log=$(docker logs "$NAME" 2>&1)
if grep -E 'UNMOCKED|EACCES|EPERM|Error:' <<< "$log"; then fail "errors in the app's log"; fi

denied=$(sudo dmesg | grep 'apparmor="DENIED"' | grep mesh_hub || true)
if [[ -n "$denied" ]]; then echo "$denied"; fail "AppArmor denied access"; fi

docker rm "$NAME" > /dev/null
echo "The image runs under its enforced AppArmor profile with nothing denied."
