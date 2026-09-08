#!/usr/bin/env bash
set -Eeuo pipefail

# Creates a dedicated, forced-command key for OS maintenance on one host.
# Usage: setup-codex-os-maintenance-access.sh <host> <ssh-alias>

server="${1:?Usage: $0 <host> <ssh-alias>}"
ssh_alias="${2:?Usage: $0 <host> <ssh-alias>}"
case "${ssh_alias}" in
  *[!A-Za-z0-9_-]*|'') echo 'Alias may contain only letters, digits, _ and -.' >&2; exit 64 ;;
esac

key_path="${HOME}/.ssh/id_ed25519_codex_os_${ssh_alias}"
ssh_config="${HOME}/.ssh/config"
mkdir -p "$(dirname "${key_path}")"
chmod 700 "$(dirname "${key_path}")"
if [[ ! -f "${key_path}" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "codex-os-maintenance-${ssh_alias}" -f "${key_path}"
fi

public_key_b64="$(base64 <"${key_path}.pub" | tr -d '\n')"
local_setup="$(mktemp -t codex-os-setup.XXXXXX)"
remote_setup="/tmp/codex-os-setup-${UID}.sh"
trap 'rm -f -- "${local_setup}"' EXIT

cat >"${local_setup}" <<'REMOTE_SETUP'
#!/usr/bin/env bash
set -Eeuo pipefail
public_key_b64="${1:?missing public key}"
login_user="${SUDO_USER:?run this installer through sudo}"
login_home="$(getent passwd "${login_user}" | cut -d: -f6)"
public_key="$(printf '%s' "${public_key_b64}" | base64 -d)"
case "${public_key}" in 'ssh-ed25519 '*) ;; *) echo 'Unsupported key.' >&2; exit 1;; esac

maintenance_tmp="$(mktemp)"
gateway_tmp="$(mktemp)"
sudoers_tmp="$(mktemp)"
trap 'rm -f -- "${maintenance_tmp}" "${gateway_tmp}" "${sudoers_tmp}"' EXIT

cat >"${maintenance_tmp}" <<'MAINTENANCE'
#!/usr/bin/env bash
set -Eeuo pipefail

show_status() {
  cat /etc/os-release
  uname -r
  df -h /
  printf '\nfailed-units\n'
  systemctl --failed --no-legend || true
  printf '\nreboot-required\n'
  test -f /var/run/reboot-required && cat /var/run/reboot-required || echo no
  printf '\nupgradable\n'
  apt list --upgradable 2>/dev/null || true
}

case "${1:-status}" in
  status) show_status ;;
  refresh-and-status)
    apt-get update
    show_status
    ;;
  apply-package-updates)
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade
    show_status
    ;;
  release-preflight)
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade
    dpkg --audit
    do-release-upgrade -c || true
    ;;
  release-upgrade)
    # Ubuntu's release upgrader remains interactive by design. Run this with a TTY.
    exec do-release-upgrade
    ;;
  reboot) exec systemctl reboot ;;
  *)
    echo 'Allowed actions: status, refresh-and-status, apply-package-updates, release-preflight, release-upgrade, reboot' >&2
    exit 64
    ;;
esac
MAINTENANCE

cat >"${gateway_tmp}" <<'GATEWAY'
#!/usr/bin/env bash
set -Eeuo pipefail
action="${SSH_ORIGINAL_COMMAND:-status}"
case "${action}" in
  status|refresh-and-status|apply-package-updates|release-preflight|release-upgrade|reboot)
    exec sudo -n /usr/local/sbin/codex-os-maintenance "${action}"
    ;;
  *) echo 'This key is restricted to OS maintenance actions.' >&2; exit 64 ;;
esac
GATEWAY

cat >"${sudoers_tmp}" <<SUDOERS
${login_user} ALL=(root) NOPASSWD: /usr/local/sbin/codex-os-maintenance status, /usr/local/sbin/codex-os-maintenance refresh-and-status, /usr/local/sbin/codex-os-maintenance apply-package-updates, /usr/local/sbin/codex-os-maintenance release-preflight, /usr/local/sbin/codex-os-maintenance release-upgrade, /usr/local/sbin/codex-os-maintenance reboot
SUDOERS
visudo -cf "${sudoers_tmp}"
install -o root -g root -m 0755 "${maintenance_tmp}" /usr/local/sbin/codex-os-maintenance
install -o root -g root -m 0755 "${gateway_tmp}" /usr/local/bin/codex-os-ssh
install -o root -g root -m 0440 "${sudoers_tmp}" /etc/sudoers.d/codex-os-maintenance

install -d -o "${login_user}" -g "$(id -gn "${login_user}")" -m 0700 "${login_home}/.ssh"
authorized_keys="${login_home}/.ssh/authorized_keys"
touch "${authorized_keys}"
chown "${login_user}:$(id -gn "${login_user}")" "${authorized_keys}"
chmod 0600 "${authorized_keys}"
sed -i '/ codex-os-maintenance-/d' "${authorized_keys}"
printf 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,command="/usr/local/bin/codex-os-ssh" %s\n' "${public_key}" >>"${authorized_keys}"
echo 'Restricted OS maintenance access installed.'
REMOTE_SETUP

chmod 0700 "${local_setup}"
scp "${local_setup}" "${server}:${remote_setup}"
echo 'The next step asks for sudo authentication on the target host.'
ssh -t "${server}" "sudo bash '${remote_setup}' '${public_key_b64}'; rm -f -- '${remote_setup}'"

touch "${ssh_config}"
chmod 0600 "${ssh_config}"
if ! grep -Eq "^[[:space:]]*Host[[:space:]]+${ssh_alias}([[:space:]]|$)" "${ssh_config}"; then
  cat >>"${ssh_config}" <<SSH_CONFIG

Host ${ssh_alias}
  HostName ${server}
  User ${USER}
  IdentityFile ${key_path}
  IdentitiesOnly yes
  BatchMode yes
SSH_CONFIG
fi

echo "Testing: ssh ${ssh_alias} status"
ssh "${ssh_alias}" status
