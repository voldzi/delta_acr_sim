#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
expected_image=${1:?Pass the reviewed immutable situation-data image ID}
[[ "$expected_image" =~ ^sha256:[a-f0-9]{64}$ ]]
test "$(id -u)" = 0
test "$(findmnt -n -o UUID --mountpoint /srv/x5-production)" = "2f93f595-b61b-4eea-9054-7afa9b275b5b"
test "$(stat -c %d /srv/x5-production)" != "$(stat -c %d /)"
test "$(docker inspect -f '{{.Image}}' csm-sim-situation-data-api)" = "$expected_image"
test ! -L sim-mobile-coverage-renewal.service
test ! -L sim-mobile-coverage-renewal.timer
sha256sum -c SHA256SUMS
systemd-analyze verify "$PWD/sim-mobile-coverage-renewal.service" "$PWD/sim-mobile-coverage-renewal.timer"
install -m 0644 sim-mobile-coverage-renewal.service /etc/systemd/system/sim-mobile-coverage-renewal.service
install -m 0644 sim-mobile-coverage-renewal.timer /etc/systemd/system/sim-mobile-coverage-renewal.timer
systemctl daemon-reload
systemctl enable --now sim-mobile-coverage-renewal.timer
systemctl start --no-block sim-mobile-coverage-renewal.service
systemctl show sim-mobile-coverage-renewal.timer -p ActiveState -p NextElapseUSecRealtime
