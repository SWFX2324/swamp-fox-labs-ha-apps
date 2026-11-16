#!/usr/bin/env bash
# Runs the real Print Log image with its AppArmor profile enforced, the way Home
# Assistant does, against the fake Home Assistant and printer in
# print_log/tests/fixtures/fake-printer.js. Fails on any denied access, any
# endpoint that doesn't answer as expected, or errors in the app's log.
#
# Expects the image built as print-log:ci and the profile loaded.
set -euo pipefail

IMAGE=print-log:ci
NAME=print-apparmor
BASE=http://127.0.0.1:8099
SERIAL=09400A000000001

data=$(mktemp -d)
chmod 777 "$data"
echo '{}' > "$data/options.json"

fail() { echo "FAIL: $*"; echo "--- app log"; docker logs "$NAME" 2>&1 | tail -50 || true; exit 1; }

# Host networking: requests from the runner come from 127.0.0.1, which the
# server accepts alongside Home Assistant's ingress proxy. FAKE_WORLD=idle so a
# print can be started.
docker run -d --name "$NAME" --network host --security-opt apparmor=print_log \
  -e FAKE_WORLD=idle \
  -v "$data:/data" -v "$PWD/print_log/tests:/app/tests:ro" \
  "$IMAGE" node --require /app/tests/fixtures/fake-printer.js /app/server.js > /dev/null

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" > /dev/null && break
  sleep 1
done
curl -sf "$BASE/api/health" > /dev/null || fail "the server didn't start"
grep -q 'ingress only' <(docker logs "$NAME" 2>&1) || fail "the ingress-only rule isn't on inside the container"
version=$(curl -sf "$BASE/api/health" | jq -r .version)
echo "version: $version"
[[ "$version" == ci ]] || fail "the app reports version '$version', not the image's 'ci'"

for p in / /app.js /style.css /favicon.svg /assets/topo-dark.svg /api/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: gzip' "$BASE$p")
  echo "$code $p"
  [[ "$code" == 200 ]] || fail "$p answered $code"
done

# Jobs from history, spools, stats: ask until the history scan has run.
for _ in $(seq 1 20); do
  state=$(curl -sf "$BASE/api/state") || fail "api/state didn't answer"
  [[ $(jq -r '.ready and (.jobCount > 0)' <<< "$state") == true ]] && break
  sleep 1
done
got=$(jq -c '{jobs: .jobCount, printer: .printers[0].name, units: [.printers[0].units[].label], start: .printers[0].controls.start, errors: .errors}' <<< "$state")
echo "snapshot: $got"
jq -e '.jobCount == 19 and .printers[0].name == "Workshop H2D" and (.printers[0].units | length) == 3 and .printers[0].controls.start == null and (.errors | length) == 0' <<< "$state" > /dev/null || fail "the snapshot isn't what the fake printer holds: $got"
[[ -s "$data/jobs.json" ]] || fail "the job log wasn't written to /data"

# The printer's files over its (fake) file connection, a plan with plate
# pictures saved to /data, a download, an upload and a start.
files=$(curl -sf "$BASE/api/files?printer=$SERIAL") || fail "api/files didn't answer"
echo "files: $(jq -c '[.files[].name]' <<< "$files")"
[[ $(jq '.files | length' <<< "$files") == 4 ]] || fail "expected 4 files"
plan=$(curl -sf "$BASE/api/plan?printer=$SERIAL&path=%2FGridfinity_2x3_bins.3mf") || fail "api/plan didn't answer"
thumb=$(jq -r '.plates[0].thumb' <<< "$plan")
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/thumb/$thumb.png")
echo "$code thumb"
[[ "$code" == 200 ]] || fail "the plate picture answered $code"
ls "$data/thumbs" | grep -q png || fail "plate pictures weren't saved to /data"
curl -sf -o /tmp/plan.3mf "$BASE/api/download?printer=$SERIAL&path=%2FGridfinity_2x3_bins.3mf" || fail "download failed"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' --data-binary @/tmp/plan.3mf "$BASE/api/upload?printer=$SERIAL&name=ci-part.3mf")
echo "$code POST api/upload"
[[ "$code" == 200 ]] || fail "upload answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"printer":"'"$SERIAL"'","path":"/Gridfinity_2x3_bins.3mf","plate":1,"mapping":[{"filament":1,"trayId":0},{"filament":2,"trayId":1}]}' "$BASE/api/start")
echo "$code POST api/start"
[[ "$code" == 200 ]] || fail "start answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/camera?printer=$SERIAL")
echo "$code camera"
[[ "$code" == 200 ]] || fail "the camera answered $code"

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
if grep -q 'fake-access-code' <<< "$log"; then fail "the access code is in the log"; fi

denied=$(sudo dmesg | grep 'apparmor="DENIED"' | grep print_log || true)
if [[ -n "$denied" ]]; then echo "$denied"; fail "AppArmor denied access"; fi

docker rm "$NAME" > /dev/null
echo "The image runs under its enforced AppArmor profile with nothing denied."
