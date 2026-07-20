# failproofai CLI-canary sandbox — base image
#
# Design goals (see failproofai-cli-canary-design.md §4):
#   - SAFE:  non-root user, NO sudo installed, no host FS mounted at runtime.
#            The canary fires `sudo whoami` / `.env`-read deny-probes; here they
#            are inert BY CONSTRUCTION even on a day enforcement is broken.
#   - LIGHT: ephemeral daily container (`docker run --rm`), not a daemon.
#            Only this image + one named volume persist; zero idle CPU/RAM.
#   - FRESH: CLIs are NOT baked in — they are `@latest`-installed into the
#            persistent HOME volume at run time (the whole point of the canary),
#            so this base image rebuilds rarely.
#
# The HOME volume (mounted at /home/canary) holds: npm-global CLIs, every
# vendor login/token, and per-CLI config — so logins survive across daily runs.

FROM node:22-bookworm-slim

# bun from the official image — no `curl | bash` needed at build time.
COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun

# Minimal tooling for the various vendor CLI installers. Deliberately NO sudo.
# Tooling for the various vendor installers. Deliberately NO sudo.
#   bzip2/xz-utils : goose extracts its Rust binary with these
#   libsecret-1-0  : antigravity caches login tokens via libsecret (best-effort)
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      git ca-certificates curl unzip bzip2 xz-utils libsecret-1-0 \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user. HOME is the mount point for the persistent named volume;
# because the image ships a canary-owned /home/canary, an empty named volume
# mounted here is initialised canary-owned (Docker copies image content+owner).
# node:22-slim already ships a `node` user at UID 1000, so pin canary to 1001.
RUN useradd --create-home --uid 1001 --shell /bin/bash canary
USER canary
WORKDIR /home/canary
RUN mkdir -p /home/canary/.npm-global/bin /home/canary/.local/bin

# NPM_CONFIG_PREFIX via ENV (not `npm config set`) so it survives the volume
# mount shadowing /home/canary at runtime. Runtime `npm i -g` lands in the volume.
ENV NPM_CONFIG_PREFIX=/home/canary/.npm-global
ENV PATH=/home/canary/.npm-global/bin:/home/canary/.local/bin:/usr/local/bin:/usr/bin:/bin

# Sanity: fail the build if bun/node/npm aren't all runnable as the canary user.
RUN bun --version && node --version && npm --version

CMD ["bash"]
