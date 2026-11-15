#!/usr/bin/env bash
# Runs the real Station Health image with its AppArmor profile enforced, the way
# Home Assistant does, against the fake Home Assistant and weather services in
# station_health/tests/fixtures/fake-world.js. Fails on any denied access, any
# endpoint that doesn't answer as expected, or errors in the app's log.
#
# Expects the image built as station-health:ci and the profile loaded.
set -euo pipefail

IMAGE=station-health:ci
NAME=station-apparmor
BASE=http://127.0.0.1:8099

data=$(mktemp -d)
chmod 777 "$data"
echo '{}' > "$data/options.json"

fail() { echo "FAIL: $*"; echo "--- app log"; docker logs "$NAME" 2>&1 | tail -50 || true; exit 1; }

# Host networking: requests from the runner come from 127.0.0.1, which the
# server accepts alongside Home Assistant's ingress proxy.
docker run -d --name "$NAME" --network host --security-opt apparmor=station_health \
  -e FAKE_WORLD=pc_off \
  -v "$data:/data" -v "$PWD/station_health/tests:/app/tests:ro" \
  "$IMAGE" node --require /app/tests/fixtures/fake-world.js /app/server.js > /dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/api/health" > /dev/null || fail "the server didn't start"
grep -q 'ingress only' <(docker logs "$NAME" 2>&1) || fail "the ingress-only rule isn't on inside the container"
# s6 hides the image's environment from the app; it must still know its version.
version=$(curl -sf "$BASE/api/health" | jq -r .version)
echo "version: $version"
[[ "$version" == ci ]] || fail "the app reports version '$version', not the image's 'ci'"

for p in / /app.js /style.css /favicon.svg /assets/topo-dark.svg /api/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' "$BASE$p")
  echo "$code $p"
  [[ "$code" == 200 ]] || fail "$p answered $code"
done

# Every source answers through the fake services: Home Assistant (states,
# registries, history, Supervisor info) and the UniFi console. The first
# answer can be early, so ask until history and the console have loaded.
for _ in $(seq 1 20); do
  state=$(curl -sf "$BASE/api/state") || fail "api/state didn't answer"
  [[ $(jq -r '(.uptime != null) and (.network.vlans != null)' <<< "$state") == true ]] && break
  sleep 1
done
for k in states registry supervisor history unifi; do
  err=$(jq -r ".sources.$k.error" <<< "$state")
  echo "$k: error=$err"
  [[ "$err" == null ]] || fail "$k didn't load: $err"
done
got=$(jq -c '{containers: .containers.total, vlans: (.network.vlans | length), level: .summary.level, needs: [.summary.needs[].text]}' <<< "$state")
echo "snapshot: $got"
jq -e '.containers.total == 11 and (.network.vlans | length) == 3 and .summary.level == "warn"' <<< "$state" > /dev/null || fail "the snapshot isn't what the fake world holds: $got"

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

denied=$(sudo dmesg | grep 'apparmor="DENIED"' | grep station_health || true)
if [[ -n "$denied" ]]; then echo "$denied"; fail "AppArmor denied access"; fi

docker rm "$NAME" > /dev/null
echo "The image runs under its enforced AppArmor profile with nothing denied."
