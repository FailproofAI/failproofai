/** Top navigation bar — wordmark, primary nav, refresh + reach-developers controls. */
"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderOpen, Shield } from "lucide-react";
import { ReachDevelopers } from "@/components/reach-developers";
import { RefreshButton } from "@/app/components/refresh-button";

const NAV_LINKS = [
  { href: "/policies", label: "Policies", icon: Shield },
  { href: "/projects", label: "Projects", icon: FolderOpen },
];

/** Local SVG copy of docs/logo/dark.svg — wordmark + green leaf gradient. */
const WORDMARK_SRC = "/wordmark.svg";

export const Navbar: React.FC<{ disabledPages?: string[] }> = ({ disabledPages = [] }) => {
  const pathname = usePathname();

  return (
    <header className="relative z-50 border-b border-border bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/exospherehost/failproofai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center hover:opacity-80 transition-opacity"
              aria-label="failproof ai · GitHub"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={WORDMARK_SRC}
                alt="failproof ai"
                style={{ height: 24, width: "auto" }}
                className="select-none"
              />
            </a>
            {process.env.NEXT_PUBLIC_APP_VERSION && (
              <span className="font-mono text-[0.6rem] leading-none text-muted-foreground/70 border border-border/60 rounded px-1.5 py-0.5 select-none tracking-wider uppercase">
                v{process.env.NEXT_PUBLIC_APP_VERSION}
              </span>
            )}

            <div className="w-px h-8 bg-border ml-2" />

            <nav className="flex items-center h-16">
              {NAV_LINKS.filter(({ href }) => {
                const key = href.slice(1);
                return !disabledPages.includes(key);
              }).map(({ href, label, icon: Icon }) => {
                const active = href === "/projects"
                  ? pathname === "/projects" || pathname.startsWith("/project/")
                  : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`relative flex items-center gap-1.5 px-3 h-full text-sm transition-colors ${
                      active
                        ? "text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${active ? "text-primary" : ""}`} />
                    {label}
                    <span
                      className={`absolute inset-x-1 bottom-0 h-[2px] transition-all ${
                        active ? "bg-primary" : "bg-transparent"
                      }`}
                    />
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-1">
            <RefreshButton />
            <div className="w-px h-6 bg-border mx-1" />
            <ReachDevelopers />
          </div>
        </div>
      </div>
    </header>
  );
};
