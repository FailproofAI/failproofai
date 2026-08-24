/**
 * Live GitHub star count in the navbar.
 *
 * `docs.json` can only carry a static string, so the count there is written by
 * hand and goes stale the moment anyone stars the repo — it sat at "1.1k" from
 * 2026-08-18 (PR #699) until it was 26% low. This replaces it in the browser on
 * every page load, so it is correct without a commit or a redeploy.
 *
 * Mintlify includes any `.js` in the content directory on every page, after the
 * page becomes interactive. See https://www.mintlify.com/docs/customize/custom-scripts
 *
 * Three things this has to survive, and the reason each is here:
 *
 *   1. The docs are a Next.js SPA. The navbar re-renders on client-side
 *      navigation and would revert to the baked-in label, so a one-shot write is
 *      not enough — hence the MutationObserver.
 *   2. The unauthenticated GitHub API allows 60 requests/hour per IP. A visitor
 *      behind a busy shared NAT can be rate-limited, so EVERY failure path must
 *      leave the label exactly as it was. A stale number beats a broken one.
 *   3. The label sits in a `truncate` span next to the icon. It must stay short
 *      and shaped like what `docs.json` already contains, or the navbar reflows
 *      visibly as the live value lands.
 */
(function () {
  "use strict";

  var REPO = "FailproofAI/failproofai";
  var API = "https://api.github.com/repos/" + REPO;
  var PREFIX = "⭐"; // the star the baked-in label already uses
  var CACHE_KEY = "fpai:stars";
  var CACHE_TTL_MS = 60 * 60 * 1000; // one hour; the display only moves every ~50 stars anyway

  /**
   * A star count as the navbar should show it: "999", "1.5k", "10k", "1.0M".
   *
   * The unit is chosen AFTER rounding, which is the whole subtlety. Deciding it
   * first renders 9_950 as "9.9k" (it is 10k) and 999_999 as "1000k" (it is
   * 1.0M), and checking the boundary before the integer rounding lets 999_499
   * through as "1000k" as well. One decimal below 10, none above, so the label
   * never grows wide enough to reflow the navbar.
   */
  function formatStars(n) {
    if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
    n = Math.floor(n);
    if (n < 1000) return String(n);

    var units = [[1e3, "k"], [1e6, "M"], [1e9, "B"]];
    for (var i = 0; i < units.length; i++) {
      var scaled = n / units[i][0];
      if (scaled >= 1000) continue;
      var shown = scaled < 9.95 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
      if (shown >= 1000) continue; // rounding promoted it into the next unit
      return (shown < 10 ? shown.toFixed(1) : String(shown)) + units[i][1];
    }
    return String(n);
  }

  /**
   * The navbar spans holding the star label.
   *
   * Matched by CONTENT, not by class: the repo link also contains a `github`
   * screen-reader span that must not be rewritten, and Mintlify's utility
   * classes are not a stable contract. A span already showing the star is
   * unambiguous, and it means this quietly does nothing if the label is ever
   * removed from `docs.json` — which is the correct behaviour, not a bug.
   */
  function labelSpans() {
    var out = [];
    var links = document.querySelectorAll('a[href*="github.com/' + REPO + '"]');
    for (var i = 0; i < links.length; i++) {
      var spans = links[i].getElementsByTagName("span");
      for (var j = 0; j < spans.length; j++) {
        if (spans[j].textContent.trim().indexOf(PREFIX) === 0) out.push(spans[j]);
      }
    }
    return out;
  }

  function apply(label) {
    var spans = labelSpans();
    for (var i = 0; i < spans.length; i++) {
      // Only write on a real change. The MutationObserver below watches the
      // subtree these spans live in, so writing unconditionally would wake it
      // on our own edit and loop.
      if (spans[i].textContent !== label) spans[i].textContent = label;
    }
  }

  function cached() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var hit = JSON.parse(raw);
      if (!hit || typeof hit.label !== "string") return null;
      if (Date.now() - hit.at > CACHE_TTL_MS) return null;
      return hit.label;
    } catch (e) {
      return null; // private mode, disabled storage, corrupt value
    }
  }

  function remember(label) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ label: label, at: Date.now() }));
    } catch (e) {
      /* storage is a nicety, never a requirement */
    }
  }

  function start(label) {
    apply(label);
    // The navbar is re-rendered on client-side navigation, which restores the
    // string from `docs.json`. Re-apply whenever the DOM changes; `apply` is a
    // no-op when the text already matches, so this stays cheap.
    if (typeof MutationObserver !== "function" || !document.body) return;
    new MutationObserver(function () {
      apply(label);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function main() {
    var hit = cached();
    if (hit) {
      start(hit);
      return;
    }
    // Cache-busting is deliberate: GitHub serves this with a short cache and the
    // browser's own copy can be older than our sessionStorage TTL.
    fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status); // 403 = rate limited
        return res.json();
      })
      .then(function (data) {
        var label = formatStars(data && data.stargazers_count);
        if (!label) return; // unexpected shape — leave the baked-in value alone
        label = PREFIX + " " + label;
        remember(label);
        start(label);
      })
      .catch(function () {
        /* Offline, rate-limited, blocked, or GitHub is down. The label stays as
           `docs.json` rendered it, which is the point of keeping that value
           accurate rather than blank. */
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    main();
  }
})();
