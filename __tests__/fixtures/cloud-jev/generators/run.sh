#!/usr/bin/env bash
# Re-generate the FailproofAI Cloud Jev parity fixtures (decide-parity.json,
# compile-parity.json, select-parity.json) by running this repo's own TypeScript.
#
# Usage: run.sh [cli-root] [fixtures-dir]
#   cli-root      defaults to this repo's root
#   fixtures-dir  defaults to __tests__/fixtures/cloud-jev (it must hold semantic-valid.json)
#
# After regenerating, copy the three files BYTE FOR BYTE into agenteye
# server/tests/fixtures/cloud_jev/ and port the change to server/src/jev_select.rs,
# jev_decide.rs and jev_cloud.rs in the same change (see the README beside the fixtures).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cli="${1:-$(cd "$here/../../../.." && pwd)}"
out="${2:-$(cd "$here/.." && pwd)}"
tmp_home="$(mktemp -d)"
trap 'rm -rf "$tmp_home"' EXIT
cd "$cli"
exec env -u HERMES_HOME -u FAILPROOFAI_HOME -u FAILPROOFAI_PACK_DIR \
  HOME="$tmp_home" bun "$here/gen-parity.ts" "$cli" "$out"
