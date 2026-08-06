#!/usr/bin/env bash
#
# Run the E2E suite against one edition.
#
#   ./scripts/dev/e2e-edition.sh core
#   ./scripts/dev/e2e-edition.sh enterprise [-- playwright args]
#
# WHY THIS EXISTS. CI only ever runs core: ADR-0002 requires the public
# pipeline to need no secrets, so it cannot fetch the private layer. The
# enterprise path is therefore exercised by nobody automatically — which is how
# two capability-gated tests sat broken from #98 and #99 until somebody
# happened to run the suite with the layer installed.
#
# The reverse gap is just as real: a developer WITH the private layer installed
# runs enterprise every time and never sees what an open-core user sees. Both
# directions have shipped bugs.
#
# So: run both before pushing anything that touches a capability-gated surface.
set -euo pipefail

cd "$(dirname "$0")/../.."

EDITION="${1:-}"
shift || true
[ "${1:-}" = "--" ] && shift || true

LINK='node_modules/@nexuspuppet/enterprise'
HIDDEN='node_modules/@nexuspuppet/.enterprise.hidden'

case "$EDITION" in
  core|enterprise) ;;
  *)
    echo "usage: $0 <core|enterprise> [-- playwright args]" >&2
    exit 2
    ;;
esac

# Restore on EVERY exit path, including Ctrl-C and a failing suite.
#
# Leaving the workspace link hidden would silently turn a developer's whole
# checkout into a core one — every later run, every later build, until they
# noticed. That is a worse outcome than the test failure that caused it.
restore() {
  if [ -e "$HIDDEN" ] || [ -L "$HIDDEN" ]; then
    mv "$HIDDEN" "$LINK"
    echo "==> restored the enterprise workspace link"
  fi
}
trap restore EXIT INT TERM

have_enterprise() { [ -e "$LINK" ] || [ -L "$LINK" ]; }

if [ "$EDITION" = 'enterprise' ] && ! have_enterprise; then
  cat >&2 <<'EOF'
The enterprise layer is not installed, so there is nothing to test.

  export NEXUSPUPPET_ENTERPRISE_REPO='git@github.com:yourorg/nexuspuppet-enterprise.git'
  npm run enterprise:fetch

This is expected on an open-core checkout — run `core` instead.
EOF
  exit 1
fi

if [ "$EDITION" = 'core' ] && have_enterprise; then
  # The API resolves @nexuspuppet/enterprise at RUNTIME through a variable
  # specifier (ADR-0002), so hiding the link is enough — no rebuild, and no
  # `npm install`, which must never run at the root while the private workspace
  # is present.
  mv "$LINK" "$HIDDEN"
  echo "==> hid the enterprise workspace link; the API will resolve nothing and boot core"
fi

echo "==> running the suite as ${EDITION}"
./scripts/ci/e2e-stack.sh "$@"
