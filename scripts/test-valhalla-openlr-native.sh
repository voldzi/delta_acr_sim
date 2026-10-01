#!/usr/bin/env bash
# Compile and exercise invented graphs only. No runtime/traffic data is mounted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-local/valhalla-graph-probe:corridor-20260929}"
docker image inspect "$IMAGE" >/dev/null
docker run --rm --platform linux/amd64 --network none --cpus 2 --memory 2g --pids-limit 128 \
  --mount "type=bind,src=$ROOT/deploy/valhalla,dst=/src,readonly" \
  --entrypoint /bin/sh "$IMAGE" -ec '
    test "$(valhalla_build_tiles --version)" = "3.8.3"
    g++-14 -std=c++23 -O1 -Wall -Wextra -Werror -I/src /src/test-openlr-native-core.cc -o /tmp/core-test
    /tmp/core-test
    g++-14 -std=c++23 -O1 -Wall -Wextra -Werror -I/src /src/openlr-native-decoder.cc \
      -o /tmp/openlr-native-decoder $(pkg-config --cflags --libs libvalhalla) -lcurl -lcrypto -llz4
    python3 /src/test-openlr-native-client.py
    python3 /src/test-openlr-native-graph.py --helper /tmp/openlr-native-decoder
    python3 /src/test-openlr-native-graph.py --helper /tmp/openlr-native-decoder --hierarchy
  '
