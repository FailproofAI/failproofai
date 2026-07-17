/**
 * Works out whether a browser error actually came from the dashboard.
 *
 * `window`'s "error" and "unhandledrejection" events are page-global: browser
 * extensions inject content scripts into the same page and share the same
 * window, so their failures reach our listeners and get reported as ours. The
 * observed case was MetaMask's "Failed to connect to MetaMask" arriving as a
 * failproofai `unhandled_rejection`. Extensions are user-installed and
 * open-ended, so the noise is unbounded and unrelated to our code.
 *
 * We therefore attribute positively — report an error only when it can be
 * traced to our own origin — rather than maintaining a denylist of extensions
 * we happen to know about. React render errors don't depend on this: the error
 * boundaries (`app/global-error.tsx`, `app/components/error-fallback.tsx`)
 * report `client_error` directly, and React only invokes those for errors thrown
 * inside our own tree.
 */

/**
 * Any `<vendor>-extension://` URL — `chrome-extension://`, `moz-extension://`,
 * `safari-web-extension://`, `ms-browser-extension://`. Matching the shared
 * suffix rather than an explicit vendor list means a new browser's scheme is
 * filtered the day it ships.
 */
const EXTENSION_URL = /\b[\w-]+-extension:\/\//i;

export type ErrorOrigin =
  /** Traceable to our own origin — a real dashboard failure. */
  | "app"
  /** Came from a browser extension sharing the page. */
  | "extension"
  /** Not attributable: no stack, or a cross-origin "Script error.". */
  | "unknown";

export interface ErrorOriginInput {
  /** `error.stack` / `reason.stack`, when the thrown value was an Error. */
  stack?: string | null;
  /** `ErrorEvent.filename` — the script URL. Absent on rejections. */
  filename?: string | null;
  /** Typically `window.location.origin`. */
  appOrigin: string;
}

/**
 * Classify where an error came from, using whatever location information the
 * browser gave us.
 *
 * Extension frames are checked first: an error whose stack passes through an
 * extension is that extension's problem even if one of our frames appears
 * further down.
 */
export function classifyErrorOrigin({ stack, filename, appOrigin }: ErrorOriginInput): ErrorOrigin {
  const text = [filename, stack].filter(Boolean).join("\n");
  if (!text.trim()) return "unknown";
  if (EXTENSION_URL.test(text)) return "extension";
  if (appOrigin && text.includes(appOrigin)) return "app";
  return "unknown";
}

/**
 * Whether an error is ours to report. Only positively-attributed errors qualify:
 * `unknown` covers cross-origin "Script error." and stack-less rejections, which
 * are unactionable anyway — there's nothing in them to debug.
 */
export function isAppError(input: ErrorOriginInput): boolean {
  return classifyErrorOrigin(input) === "app";
}
