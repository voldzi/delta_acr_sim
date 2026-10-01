#!/usr/bin/env bash
# Staged user-owned offline helper. No provider traffic or live archive writes.
set -Eeuo pipefail
[[ $# == 3 ]] || exit 64
work="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "$work" =~ ^/home/voldzi/valhalla-owned-deploy/native-shadow-[A-Za-z0-9_-]+$ ]] || exit 64
[[ "$1" == "$work/graph-config.json" && "$2" =~ ^sim-routing-[A-Za-z0-9_-]+$ && "$3" =~ ^[0-9a-f]{64}$ ]] || exit 64
graph="$(readlink -f /srv/valhalla/current)"
[[ "$graph" =~ ^/srv/valhalla/releases/[A-Za-z0-9_-]+/custom_files$ ]] || exit 65
name="sim-openlr-native-shadow-$(basename "$work")"
image=ghcr.io/valhalla/valhalla-scripted:3.8.3@sha256:24ef7955899dececb94e26c6dfb89d64fabfae875f980432694b0261eb6c251b
docker container inspect "$name" >/dev/null 2>&1 && exit 66
umask 077
control="$(mktemp -d /tmp/sim-native-shadow-control.XXXXXX)"
cidfile="$control/container-id"
cleanup() {
  if [[ -s "$cidfile" ]]; then
    read -r owned_id < "$cidfile" || true
    [[ "${owned_id:-}" =~ ^[0-9a-f]{64}$ ]] && docker rm -f "$owned_id" >/dev/null 2>&1 || true
  fi
  rm -f -- "$cidfile"
  rmdir -- "$control" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
timeout --foreground --signal=TERM --kill-after=5s 1800 docker run --rm -i --name "$name" --cidfile "$cidfile" \
  --network none --read-only --user "$(id -u):$(id -g)" --cpus 1 --memory 768m --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$graph/valhalla_tiles.tar,dst=/graph/valhalla_tiles.tar,readonly" \
  --mount "type=bind,src=$work,dst=/work,readonly" \
  --entrypoint /work/openlr-native-decoder "$image" /work/graph-config.json "$2" "$3"
