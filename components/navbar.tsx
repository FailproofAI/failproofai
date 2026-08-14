/** Top navigation bar — wordmark, primary nav, refresh + settings + reach-us.
 *
 * Restyled to the audit / brutalist-pixel-craft system: the wordmark uses the
 * same pixel pink mark + Bitcount Prop Single lowercase name as the audit
 * report, and each nav link is a `.tab` with a sharp pink underline on the
 * active route.
 *
 * The bar was text-forward with no icons. Settings is the one exception, and
 * deliberately so: the tabs are VIEWS OF DATA (projects, policies, audit) and
 * settings is machine configuration, so putting it in that row would have
 * claimed it was another place to look at results. As an icon among the other
 * chrome controls it reads as what it is.
 */
"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { ReachDevelopers } from "@/components/reach-developers";
import { RefreshButton } from "@/app/components/refresh-button";
import { usePostHog } from "@/contexts/PostHogContext";

const NAV_LINKS = [
  { href: "/projects", label: "projects" },
  { href: "/policies", label: "policies" },
  { href: "/audit", label: "audit" },
];

const REMOTE_LOGO_URL =
  "https://exospherehost.slack.com/archives/C0B6RL08SLF/p1780910285021619?thread_ts=1780910239.057609&cid=C0B6RL08SLF";
const LOCAL_LOGO_URL = "/logo.svg";

/** Resolves the brand logo: first tries the remote URL, falls back to the
 *  bundled asset (served from /public, mirrored at assets/logos/company/logo.svg)
 *  if the fetch fails for any reason. */
const useBrandLogo = (): string => {
  const [src, setSrc] = React.useState<string>(LOCAL_LOGO_URL);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(REMOTE_LOGO_URL, { method: "GET", mode: "cors" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (cancelled) URL.revokeObjectURL(url);
        else setSrc(url);
      } catch {
        if (!cancelled) setSrc(LOCAL_LOGO_URL);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return src;
};

export const Navbar: React.FC<{
  disabledPages?: string[];
}> = ({ disabledPages = [] }) => {
  const pathname = usePathname();
  const { capture } = usePostHog();
  const logoSrc = useBrandLogo();

  const sectionLabel = (() => {
    if (pathname.startsWith("/policies")) return "policies";
    if (pathname.startsWith("/audit")) return "audit";
    if (pathname.startsWith("/settings")) return "settings";
    if (pathname.startsWith("/projects") || pathname.startsWith("/project/")) return "projects";
    return "";
  })();

  return (
    <header className="app-header">
      {/* Brand — logo mark + name only (no version/section here) */}
      <a
        href="https://github.com/failproofai/failproofai"
        target="_blank"
        rel="noopener noreferrer"
        className="h-brand"
        style={{ flex: "none" }}
        aria-label="failproof ai · GitHub"
      >
        <img src={logoSrc} alt="failproof_ai" style={{ height: 18, display: "block", flexShrink: 0 }} />
      </a>

      {/* Nav links — swapped to sit right after the brand */}
      <nav className="tabs" style={{ border: "none", padding: 0, gap: 0 }}>
        {NAV_LINKS.filter(({ href }) => {
          const key = href.slice(1);
          return !disabledPages.includes(key);
        }).map(({ href, label }) => {
          const active = href === "/projects"
            ? pathname === "/projects" || pathname.startsWith("/project/")
            : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`tab${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (href !== "/audit") return;
                capture("audit_nav_clicked", {
                  from_path: pathname,
                  is_active_tab: active,
                });
              }}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Spacer pushes version/section + actions to the right */}
      <div style={{ flex: 1 }} />

      {/* Version + section label — swapped to right of nav. `.h-meta` never
          wraps mid-token and is hidden entirely on narrow viewports (it
          duplicates the active tab highlight). */}
      {(process.env.NEXT_PUBLIC_APP_VERSION || sectionLabel) && (
        <div className="h-meta">
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <span className="h-version">
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          )}
          {sectionLabel && process.env.NEXT_PUBLIC_APP_VERSION && (
            <span className="h-brand-sep" aria-hidden="true">·</span>
          )}
          {sectionLabel && <span className="h-brand-section">{sectionLabel}</span>}
        </div>
      )}

      <div className="h-actions">
        <RefreshButton />
        <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 6px" }} />
        {/* Settings sits between the refresh controls and reach-us as an ICON,
            not a nav tab: it is machine configuration rather than a view of the
            data, so it belongs with the other chrome controls rather than
            beside projects / policies / audit. */}
        <Link
          href="/settings"
          className={`h-icon-btn${pathname.startsWith("/settings") ? " is-active" : ""}`}
          aria-label="settings"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          title="settings"
        >
          <Settings className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 6px" }} />
        <ReachDevelopers />
      </div>
    </header>
  );
};
