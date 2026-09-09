/**
 * Reo.dev beacon.
 *
 * Reo identifies the companies reading these docs and feeds that into the
 * outbound funnel — the docs are the top of it, so the beacon has to be here
 * and not only on the marketing site.
 *
 * Mintlify includes any `.js` in the content directory on every page, once per
 * full page load, after the page becomes interactive. That is the whole install
 * — there is no head-injection hook in `docs.json`, and Reo's own Mintlify guide
 * prescribes exactly this file. See:
 *   https://www.mintlify.com/docs/customize/custom-scripts
 *   https://docs.reo.dev/integrations/developer-docs/mintlify
 *
 * Kept byte-for-byte as Reo issues it, minified loader and all, so it can be
 * diffed against the vendor snippet without reading past the formatting. The
 * client ID appears twice on purpose: once to build the script URL, once in the
 * `Reo.init` call the loader fires on load. `__tests__/docs/reo.test.ts` drives
 * it in a DOM and asserts the two are the same tenant — a mismatched pair still
 * loads a real script, it just reports to nobody, and the only symptom is an
 * empty dashboard.
 *
 * The docs are a Next.js SPA and this does not re-run on client-side
 * navigation, so there is no double-init to guard against; Reo tracks route
 * changes itself once initialised. (`docs/stars.js` needs a MutationObserver
 * for exactly the same reason, from the other direction.)
 */
!function(){var e,t,n;e="023277be3290bc6",t=function(){Reo.init({clientID:"023277be3290bc6"})},(n=document.createElement("script")).src="https://static.reo.dev/"+e+"/reo.js",n.defer=!0,n.onload=t,document.head.appendChild(n)}();
