#!/usr/bin/env sh
set -eu

mkdir -p /traffic
if [ ! -s /traffic/traffic.tar ] && [ -s /custom_files/traffic-skeleton.tar ]; then
  cp /custom_files/traffic-skeleton.tar /traffic/traffic.tar
  chmod 0644 /traffic/traffic.tar
fi

exec valhalla_service "$@"
