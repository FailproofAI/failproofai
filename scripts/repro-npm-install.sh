#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Reproduce a REAL user install, in the shape that actually breaks.
#
#   sudo npm i -g failproofai      (global prefix owned by root)
#   then run the CLI as a NORMAL user
#
# That split is the whole point. A single-user laptop where npm's prefix is
# owned by the person running the hooks hides an entire class of bug — it is
# how the root-owned policy-shim fail-open shipped: every hook run by a non-root
# user hit EACCES, the policy never loaded, and the hook exited 0 ALLOWING the
# call, while builtins kept firing so the machine looked protected.
#
# systemd is real here (jrei/systemd-ubuntu), so `failproofai config` installs
# and starts the actual service rather than skipping that half.
#
# Usage:
#   scripts/repro-npm-install.sh              # build, pack, drop into a shell
#   scripts/repro-npm-install.sh --published  # install the last RELEASE instead
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

IMAGE=jrei/systemd-ubuntu:24.04
NAME=fpai-repro
USER_IN_BOX=dev
PUBLISHED=0
[ "${1:-}" = "--published" ] && PUBLISHED=1

VERSION=$(node -p "require('$REPO/package.json').version")
say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# ── 1. Build what a tarball would carry ──────────────────────────────────────
if [ "$PUBLISHED" -eq 0 ]; then
  say "Building dist + daemon"
  [ -f dist/cli.mjs ] || bun run build
  [ -f target/release/failproofaid ] || cargo build --release --bin failproofaid

  # `dist/cli.mjs` INLINES the version at build time. `npm pack --ignore-scripts`
  # skips the `prepare` script that would rebuild it, so bumping package.json
  # without rebuilding packs a bundle that reports the OLD version — and you
  # spend an afternoon testing code you did not write. A real publish never hits
  # this (publish.yml builds, and `prepare` runs on a normal pack); this is a
  # trap of the fast path only, which is exactly why it is checked here.
  if ! grep -q "$VERSION" dist/cli.mjs 2>/dev/null; then
    say "dist is stale (built for $(grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+-beta\.[0-9]\+' dist/cli.mjs | head -1)) — rebuilding"
    bun run build
  fi

  say "Packing $VERSION"
  rm -f failproofai-*.tgz
  npm pack --ignore-scripts >/dev/null 2>&1
  TARBALL="$REPO/failproofai-$VERSION.tgz"
  [ -f "$TARBALL" ] || { echo "pack failed"; exit 1; }
  ls -la "$TARBALL" | awk '{printf "  %s bytes  %s\n", $5, $9}'

  # Belt and braces: assert what is actually IN the tarball, not what we meant
  # to put there.
  PACKED=$(tar -xzOf "$TARBALL" package/dist/cli.mjs 2>/dev/null \
             | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+-beta\.[0-9]\+' | head -1)
  if [ "$PACKED" != "$VERSION" ]; then
    echo "  REFUSING: tarball reports '$PACKED' but package.json says '$VERSION'"
    exit 1
  fi
  echo "  bundled version verified: $PACKED"
fi

# ── 2. A container with a real init ──────────────────────────────────────────
say "Starting $IMAGE (real systemd)"
docker rm -f "$NAME" >/dev/null 2>&1
# --cgroupns=host + the two tmpfs mounts are REQUIRED on a cgroup v2 host
# (anything modern). Without them systemd cannot set up its own hierarchy and
# the container exits 255 immediately, with an empty `docker logs` — which is
# a genuinely awful thing to debug, hence the comment.
docker run -d --name "$NAME" --privileged --cgroupns=host \
  --network=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  ${TARBALL:+-v "$TARBALL":/pkg.tgz:ro} \
  -v "$REPO/target/release/failproofaid":/opt/failproofaid:ro \
  "$IMAGE" >/dev/null
# Wait for systemd to finish booting, or `systemctl` answers nothing useful.
until docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; do
  if ! docker ps --filter "name=$NAME" --format '{{.Names}}' | grep -q "$NAME"; then
    echo "  container died during boot — cgroup v2 flags wrong for this host?"
    docker logs "$NAME" 2>&1 | tail -5
    exit 1
  fi
  sleep 1
done
echo "  systemd: $(docker exec "$NAME" systemctl is-system-running 2>/dev/null)"

# ── 3. Node, and a NON-ROOT user to run as ───────────────────────────────────
say "Installing Node + creating an unprivileged user"
docker exec "$NAME" bash -lc '
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq curl ca-certificates sudo >/dev/null 2>&1
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/n.sh 2>/dev/null && bash /tmp/n.sh >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
  node --version
' 2>&1 | sed 's/^/  node /'

docker exec "$NAME" bash -lc "
  id $USER_IN_BOX >/dev/null 2>&1 || useradd -m -s /bin/bash $USER_IN_BOX
  # Passwordless sudo: the daemon install needs root, and we are testing the
  # INSTALL, not whether a human can type a password.
  echo '$USER_IN_BOX ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/$USER_IN_BOX
  chmod 440 /etc/sudoers.d/$USER_IN_BOX
"

# ── 4. Install globally AS ROOT — the shape that exposes ownership bugs ──────
say "npm install -g (as root)"
if [ "$PUBLISHED" -eq 1 ]; then
  docker exec "$NAME" bash -lc "npm install -g failproofai@$VERSION 2>&1 | tail -4"
else
  docker exec "$NAME" bash -lc "npm install -g /pkg.tgz 2>&1 | tail -4"
fi

say "Who owns the global install?"
docker exec "$NAME" bash -lc '
  P=$(npm root -g)/failproofai
  stat -c "  %U:%G %a  %n" "$P" 2>/dev/null
  stat -c "  %U:%G %a  %n" "$P/dist" 2>/dev/null
'

# ── 5. Hand over, running as the unprivileged user ───────────────────────────
say "Ready"
cat <<EOF

  The box is up as container "$NAME". Everything below runs as the
  UNPRIVILEGED user, against a root-owned global install — the real shape.

  Shell in:
    docker exec -it -u $USER_IN_BOX $NAME bash -l

  Then, inside:
    failproofai --version
    failproofai config          # real systemd service install
    systemctl status failproofaid@$USER_IN_BOX

  The daemon binary is mounted at /opt/failproofaid. There is no GitHub
  release for $VERSION, so point the CLI at it rather than letting it try
  to download one:
    export FAILPROOFAI_DAEMON_BINARY=/opt/failproofaid

  Fire a hook exactly as an agent CLI would:
    printf '{"session_id":"s","cwd":"'"\$PWD"'","hook_event_name":"PreToolUse",
    "tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}' \\
      | failproofai --hook PreToolUse --cli claude

  Tear down:
    docker rm -f $NAME

EOF
