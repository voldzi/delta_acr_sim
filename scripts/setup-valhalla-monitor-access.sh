#!/usr/bin/env bash
# Run on the operator Mac. No sudo, no credential export, no update actions.
set -euo pipefail
if [ "${1:-}" != '--install' ]; then
  echo 'Usage: bash scripts/setup-valhalla-monitor-access.sh --install' >&2
  exit 2
fi
public_key="$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes docker.home.cz 'set -eu
  umask 077
  dir="$HOME/.config/csm-sim/valhalla-monitor"
  mkdir -p "$dir"
  chmod 700 "$dir"
  if [ ! -f "$dir/id_ed25519" ]; then
    ssh-keygen -q -t ed25519 -N "" -C sim-valhalla-readonly-monitor -f "$dir/id_ed25519"
  fi
  chmod 600 "$dir/id_ed25519"
  ssh-keygen -y -f "$dir/id_ed25519"' | awk '$1 == "ssh-ed25519" {print $1 " " $2}')"
if [[ ! "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]]; then
  echo 'Unexpected public-key format; no access installed.' >&2
  exit 1
fi
# Key is public, passed on stdin, and only permits fixed status. All requested
# remote commands are overridden; existing root allowlist is not extended.
printf '%s\n' "$public_key" | ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes valhalla.home.cz 'set -eu
  read -r key
  test -x /usr/local/bin/valhalla-codex-ssh
  test -w "$HOME/.ssh/authorized_keys"
  line="restrict,command=\"env SSH_ORIGINAL_COMMAND=status /usr/local/bin/valhalla-codex-ssh\" $key sim-valhalla-readonly-monitor"
  if ! grep -Fqx "$line" "$HOME/.ssh/authorized_keys"; then
    test "$(grep -c sim-valhalla-readonly-monitor "$HOME/.ssh/authorized_keys" || true)" = 0
    cp -p "$HOME/.ssh/authorized_keys" "$HOME/.ssh/authorized_keys.before-sim-monitor-$(date -u +%Y%m%dT%H%M%SZ)"
    printf "\n%s\n" "$line" >> "$HOME/.ssh/authorized_keys"
  fi
'
ssh -T -o BatchMode=yes docker.home.cz 'ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -i "$HOME/.config/csm-sim/valhalla-monitor/id_ed25519" voldzi@valhalla.home.cz status >/dev/null'
echo 'Read-only monitor access verified. Private key remains on docker.home.cz.'
