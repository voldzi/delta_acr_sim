#!/usr/bin/env bash
set -Eeuo pipefail

# Installs a dedicated, forced-command SSH key for narrowly scoped Valhalla
# maintenance. The key cannot open a shell or run arbitrary sudo commands.

server="${1:-valhalla.home.cz}"
key_path="${VALHALLA_CODEX_KEY_PATH:-${HOME}/.ssh/id_ed25519_codex_valhalla}"
ssh_alias="${VALHALLA_CODEX_SSH_ALIAS:-valhalla-codex}"
ssh_config="${HOME}/.ssh/config"

mkdir -p "$(dirname "${key_path}")"
chmod 700 "$(dirname "${key_path}")"

if [[ ! -f "${key_path}" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'codex-valhalla-maintenance' -f "${key_path}"
fi

if [[ ! -f "${key_path}.pub" ]]; then
  echo "Missing public key: ${key_path}.pub" >&2
  exit 1
fi

public_key_b64="$(base64 <"${key_path}.pub" | tr -d '\n')"
local_setup="$(mktemp -t valhalla-codex-setup.XXXXXX)"
remote_setup="/tmp/valhalla-codex-setup-${UID}.sh"
trap 'rm -f -- "${local_setup}"' EXIT

cat >"${local_setup}" <<'REMOTE_SETUP'
#!/usr/bin/env bash
set -Eeuo pipefail

public_key_b64="${1:?missing public key}"
login_user="${SUDO_USER:?run this installer through sudo}"
login_home="$(getent passwd "${login_user}" | cut -d: -f6)"
public_key="$(printf '%s' "${public_key_b64}" | base64 -d)"

case "${public_key}" in
  'ssh-ed25519 '*|'sk-ssh-ed25519@openssh.com '*) ;;
  *) echo 'Unsupported public-key format.' >&2; exit 1 ;;
esac

maintenance_tmp="$(mktemp)"
gateway_tmp="$(mktemp)"
sudoers_tmp="$(mktemp)"
trap 'rm -f -- "${maintenance_tmp}" "${gateway_tmp}" "${sudoers_tmp}"' EXIT

cat >"${maintenance_tmp}" <<'MAINTENANCE'
#!/usr/bin/env bash
set -Eeuo pipefail

state_dir='/srv/valhalla/state'
releases_dir='/srv/valhalla/releases'
service='valhalla-weekly-update.service'

show_state() {
  systemctl show "${service}" -p ActiveState -p SubState -p Result -p ExecMainStatus
  systemctl show valhalla-weekly-update.timer -p ActiveState -p NextElapseUSecRealtime
  systemctl show valhalla-healthcheck.service -p ActiveState -p Result -p ExecMainStatus
  printf '\nlast-attempt.env\n'
  sed -n '1,80p' "${state_dir}/last-attempt.env" 2>/dev/null || true
  printf '\nlast-success.env\n'
  sed -n '1,80p' "${state_dir}/last-success.env" 2>/dev/null || true
  printf '\ncurrent\n'
  readlink -f /srv/valhalla/current || true
  printf '\nreleases\n'
  find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
  printf '\ndisk\n'
  df -h /srv/valhalla
  printf '\nvalhalla-status\n'
  curl -fsS --max-time 10 http://127.0.0.1:8002/status \
    || curl -fsS --max-time 10 http://valhalla.home.cz:8002/status \
    || true
  printf '\n'
}

prune_old_releases() {
  active_target="$(readlink -f /srv/valhalla/current)"
  active_release="$(dirname "${active_target}")"
  previous_target="$(sed -n 's/^PREVIOUS_TARGET=//p' "${state_dir}/last-success.env" | tail -1)"
  previous_release=''
  if [[ -n "${previous_target}" ]]; then
    previous_release="$(dirname "${previous_target}")"
  fi

  case "${active_release}" in
    "${releases_dir}"/20??????T??????Z) ;;
    *) echo "Refusing to prune: unexpected active release ${active_release}" >&2; exit 1 ;;
  esac
  if [[ -n "${previous_release}" ]]; then
    case "${previous_release}" in
      "${releases_dir}"/20??????T??????Z) ;;
      *) echo "Refusing to prune: unexpected previous release ${previous_release}" >&2; exit 1 ;;
    esac
  fi

  while IFS= read -r -d '' release_dir; do
    [[ "${release_dir}" == "${active_release}" ]] && continue
    [[ -n "${previous_release}" && "${release_dir}" == "${previous_release}" ]] && continue
    echo "Removing obsolete release: ${release_dir}"
    rm -rf --one-file-system -- "${release_dir}"
  done < <(find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -print0)
}

case "${1:-status}" in
  status)
    show_state
    ;;
  logs)
    journalctl -u valhalla-weekly-update.service -u valhalla-healthcheck.service -n 250 --no-pager
    ;;
  prune-old-releases)
    prune_old_releases
    df -h /srv/valhalla
    ;;
  update)
    systemctl reset-failed valhalla-weekly-update.service valhalla-healthcheck.service
    systemctl start --no-block valhalla-weekly-update.service
    show_state
    ;;
  healthcheck)
    systemctl reset-failed valhalla-healthcheck.service
    systemctl start valhalla-healthcheck.service
    show_state
    ;;
  enable-auto-prune)
    install -d -m 0755 /etc/systemd/system/valhalla-weekly-update.service.d
    printf '%s\n' '[Service]' 'ExecStartPre=/usr/local/sbin/valhalla-codex-maintenance prune-old-releases' \
      >/etc/systemd/system/valhalla-weekly-update.service.d/10-prune-old-releases.conf
    chmod 0644 /etc/systemd/system/valhalla-weekly-update.service.d/10-prune-old-releases.conf
    systemctl daemon-reload
    systemctl cat valhalla-weekly-update.service
    ;;
  disable-auto-prune)
    rm -f -- /etc/systemd/system/valhalla-weekly-update.service.d/10-prune-old-releases.conf
    systemctl daemon-reload
    systemctl cat valhalla-weekly-update.service
    ;;
  *)
    echo 'Allowed actions: status, logs, prune-old-releases, update, healthcheck, enable-auto-prune, disable-auto-prune' >&2
    exit 64
    ;;
esac
MAINTENANCE

cat >"${gateway_tmp}" <<'GATEWAY'
#!/usr/bin/env bash
set -Eeuo pipefail

action="${SSH_ORIGINAL_COMMAND:-status}"
case "${action}" in
  status|logs|prune-old-releases|update|healthcheck|enable-auto-prune|disable-auto-prune)
    exec sudo -n /usr/local/sbin/valhalla-codex-maintenance "${action}"
    ;;
  *)
    echo 'This key is restricted to Valhalla maintenance actions.' >&2
    exit 64
    ;;
esac
GATEWAY

cat >"${sudoers_tmp}" <<SUDOERS
${login_user} ALL=(root) NOPASSWD: /usr/local/sbin/valhalla-codex-maintenance status, /usr/local/sbin/valhalla-codex-maintenance logs, /usr/local/sbin/valhalla-codex-maintenance prune-old-releases, /usr/local/sbin/valhalla-codex-maintenance update, /usr/local/sbin/valhalla-codex-maintenance healthcheck, /usr/local/sbin/valhalla-codex-maintenance enable-auto-prune, /usr/local/sbin/valhalla-codex-maintenance disable-auto-prune
SUDOERS

visudo -cf "${sudoers_tmp}"
install -o root -g root -m 0755 "${maintenance_tmp}" /usr/local/sbin/valhalla-codex-maintenance
install -o root -g root -m 0755 "${gateway_tmp}" /usr/local/bin/valhalla-codex-ssh
install -o root -g root -m 0440 "${sudoers_tmp}" /etc/sudoers.d/valhalla-codex-maintenance

install -d -o "${login_user}" -g "$(id -gn "${login_user}")" -m 0700 "${login_home}/.ssh"
authorized_keys="${login_home}/.ssh/authorized_keys"
touch "${authorized_keys}"
chown "${login_user}:$(id -gn "${login_user}")" "${authorized_keys}"
chmod 0600 "${authorized_keys}"
sed -i '/ codex-valhalla-maintenance$/d' "${authorized_keys}"
printf 'restrict,command="/usr/local/bin/valhalla-codex-ssh" %s\n' "${public_key}" >>"${authorized_keys}"

echo 'Restricted Valhalla maintenance access installed.'
REMOTE_SETUP

chmod 0700 "${local_setup}"

echo "Uploading restricted-access installer to ${server}..."
scp "${local_setup}" "${server}:${remote_setup}"
echo 'The next step asks for sudo authentication on the Valhalla server.'
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

echo
echo "Testing: ssh ${ssh_alias} status"
ssh "${ssh_alias}" status
echo
echo "Installed. Revoke by removing the 'codex-valhalla-maintenance' line from authorized_keys and /etc/sudoers.d/valhalla-codex-maintenance."
