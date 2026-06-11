#!/usr/bin/env bash
# Validates the CSM SIM application skeleton against the central standards.
# SIM keeps a mapped numbered documentation convention; see docs/README.md
# and docs/adr/0009_KEEP_NUMBERED_DOCUMENTATION_CONVENTION.md.
set -euo pipefail

root="${1:-.}"
failures=0

ok() { echo "ok:   $*"; }
fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

require_file() {
  if [[ -f "$root/$1" ]]; then
    ok "$1 exists"
  else
    fail "$1 is missing"
  fi
}

require_dir() {
  if [[ -d "$root/$1" ]]; then
    ok "$1/ exists"
  else
    fail "$1/ is missing"
  fi
}

required_files=(
  README.md
  AGENTS.md
  CLAUDE.md
  .env.example
  docs/README.md
  docs/00_INDEX.md
  docs/architecture/00_INDEX.md
  docs/api/00_INDEX.md
  docs/security/00_INDEX.md
  docs/runbooks/00_INDEX.md
  docs/application/09_OBSERVABILITY.md
  docs/adr/0009_KEEP_NUMBERED_DOCUMENTATION_CONVENTION.md
  docs/adr/0010_JSON_FIRST_COMPOSITE_OPENAPI.md
  openapi/openapi.json
  openapi/README.md
)

for file in "${required_files[@]}"; do
  require_file "$file"
done

require_dir docs/adr
require_dir docs/archive

strip_compact() {
  sed '/^## Compact Instructions$/,$d' "$1" | grep -v '^[[:space:]]*$' || true
}

if [[ -f "$root/AGENTS.md" && -f "$root/CLAUDE.md" ]]; then
  if diff <(strip_compact "$root/CLAUDE.md") <(grep -v '^[[:space:]]*$' "$root/AGENTS.md" || true) >/dev/null 2>&1; then
    ok "AGENTS.md and CLAUDE.md are aligned"
  else
    fail "AGENTS.md and CLAUDE.md differ beyond the Compact Instructions section"
  fi
fi

if [[ -f "$root/docs/README.md" ]]; then
  for topic in "Architecture" "API" "Security" "Operations" "Observability" "Runbook" "ADRs" "Environment"; do
    if grep -q "| $topic |" "$root/docs/README.md"; then
      ok "docs/README.md maps $topic"
    else
      fail "docs/README.md does not map $topic"
    fi
  done
fi

if [[ -f "$root/openapi/openapi.json" ]]; then
  if python3 -m json.tool "$root/openapi/openapi.json" >/dev/null 2>&1; then
    ok "openapi/openapi.json is valid JSON"
  else
    fail "openapi/openapi.json is not valid JSON"
  fi
fi

if [[ -f "$root/docs/api/00_INDEX.md" ]]; then
  if grep -q "openapi/openapi.json" "$root/docs/api/00_INDEX.md"; then
    ok "docs/api/00_INDEX.md references openapi/openapi.json"
  else
    fail "docs/api/00_INDEX.md does not reference openapi/openapi.json"
  fi
fi

if compgen -G "$root/docs/api/openapi-*.yaml" >/dev/null; then
  fail "active OpenAPI YAML files remain in docs/api; archive or generate them from openapi/openapi.json"
else
  ok "no active OpenAPI YAML files in docs/api"
fi

if [[ -f "$root/openapi/openapi.yaml" ]]; then
  if head -n 2 "$root/openapi/openapi.yaml" | grep -q "generated from openapi/openapi.json"; then
    ok "openapi/openapi.yaml is marked as generated"
  else
    fail "openapi/openapi.yaml exists but is not marked as generated from openapi/openapi.json"
  fi
fi

echo
if [[ "$failures" -gt 0 ]]; then
  echo "Skeleton validation failed: $failures problem(s)."
  exit 1
fi

echo "Skeleton validation passed."
