#!/usr/bin/env bash
set -Eeuo pipefail

marker='/run/valhalla-traffic-canary/active'
if [[ ! -e "${marker}" ]]; then
  exit 0
fi

# Idempotent emergency recovery for ExecStopPost as well as normal completion.
docker rm -f valhalla-traffic-canary >/dev/null 2>&1 || true
if [[ "$(docker inspect --format '{{.State.Running}}' valhalla)" != 'true' ]]; then
  docker start valhalla >/dev/null
fi

ready=false
for _ in {1..50}; do
  if curl -fsS --max-time 5 http://192.168.10.134:8002/status >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 3
done
if [[ "${ready}" != true ]]; then
  echo 'CRITICAL: ordinary Valhalla did not recover; traffic timer stays stopped.' >&2
  exit 1
fi

systemctl start valhalla-traffic-update.timer
rm -f -- "${marker}"
echo 'Ordinary Valhalla and its traffic timer were restored.'
