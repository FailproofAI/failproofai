/**
 * A dependency-free POSIX `resolve` / `join`, for the sealed policy runtime.
 *
 * The sealed tier evaluates inside a QuickJS context with **no bindings
 * registered** — no filesystem, no process, no network, and therefore no
 * `node:path` either. But three sealed-eligible builtins do real path
 * arithmetic (`block-read-outside-cwd`, `block-rm-rf`, and the agent-internal
 * whitelist they share), so the arithmetic has to come from somewhere.
 *
 * Two options were available and only one is honest. Registering a Rust-backed
 * `path` binding would put a host-implemented function inside the sealed
 * context, which is exactly the surface the tier exists to have none of — and
 * it would silently differ from Node's semantics at the edges, which is where
 * path bugs live. So instead: reimplement the two functions, in plain
 * JavaScript, with no capabilities at all, and **prove equivalence against
 * `node:path.posix` differentially** rather than by reading the spec twice.
 * `__tests__/policy-runtime/pure-path.test.ts` does that over a generated
 * corpus, including the adversarial cases (`..` past root, trailing slashes,
 * empty segments, embedded `.`), and any divergence is a test failure rather
 * than a policy that quietly whitelists the wrong directory.
 *
 * POSIX only, deliberately. Windows daemon support is out of scope for Phase 1
 * (see the Phase 1 README), and the two callers already normalise backslashes
 * to forward slashes themselves before comparing.
 */

/**
 * The working directory `resolve()` falls back to when no argument supplies an
 * absolute path.
 *
 * Node uses `process.cwd()` here. The sealed context has no process, and more
 * to the point it *must* not have one: a cwd read from the daemon's own process
 * would be wherever the daemon was launched, not where the request came from —
 * and it would be that for every session on the machine. Every call site in
 * the builtins passes an absolute `cwd` as the first argument, so this fallback
 * is unreachable in practice — `/` is chosen so that if it ever is reached the
 * result is a well-formed absolute path that matches nothing rather than a
 * relative path that could compare `startsWith` against anything.
 */
const SEALED_CWD = "/";

/**
 * Collapse `.` and `..` segments, mirroring Node's internal `normalizeString`.
 *
 * `allowAboveRoot` distinguishes the two callers: `resolve` has already
 * guaranteed an absolute path, so a leading `..` is dropped (you cannot go
 * above `/`), while `join` may produce a relative path where a leading `..` is
 * meaningful and must be preserved.
 */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;

  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (code === 47 /* / */) {
      break;
    } else {
      code = 47;
    }

    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // "//" or "/./" — nothing to do.
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== 46 /* . */ ||
          res.charCodeAt(res.length - 2) !== 46 /* . */
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `/${path.slice(lastSlash + 1, i)}`;
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 /* . */ && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/** `path.posix.resolve`. Always returns an absolute, normalised path. */
export function resolve(...args: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;

  for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
    const path = args[i];
    if (typeof path !== "string") {
      throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`);
    }
    if (path.length === 0) continue;

    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.charCodeAt(0) === 47 /* / */;
  }

  if (!resolvedAbsolute) {
    resolvedPath = `${SEALED_CWD}/${resolvedPath}`;
  }

  resolvedPath = normalizeString(resolvedPath, false);

  return resolvedPath.length > 0 ? `/${resolvedPath}` : "/";
}

/** `path.posix.join`. May return a relative path. */
export function join(...args: string[]): string {
  if (args.length === 0) return ".";

  let joined: string | undefined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (typeof arg !== "string") {
      throw new TypeError(`Path must be a string. Received ${JSON.stringify(arg)}`);
    }
    if (arg.length > 0) {
      if (joined === undefined) joined = arg;
      else joined += `/${arg}`;
    }
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

/**
 * Namespace export, for call sites that write `import path from "node:path"`
 * (`lib/telemetry-id.ts` does). The bundler substitutes this module for
 * `node:path`, so it has to satisfy both the named and default import shapes.
 */
const posixPath = { resolve, join, normalize };
export default posixPath;

/** `path.posix.normalize`. Exported because `join` needs it and tests assert it. */
export function normalize(path: string): string {
  if (path.length === 0) return ".";

  const isAbsolute = path.charCodeAt(0) === 47 /* / */;
  const trailingSeparator = path.charCodeAt(path.length - 1) === 47;

  let normalized = normalizeString(path, !isAbsolute);

  if (normalized.length === 0) {
    if (isAbsolute) return "/";
    return trailingSeparator ? "./" : ".";
  }
  if (trailingSeparator) normalized += "/";

  return isAbsolute ? `/${normalized}` : normalized;
}
