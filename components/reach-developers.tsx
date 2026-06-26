/** Dropdown menu for users to reach the development team via GitHub. */
"use client";

import React, { useState, useCallback } from "react";
import { GitBranch, ChevronDown, Star, BookOpen, MessageCircle, MessageSquareWarning } from "lucide-react";
import { Button } from "@/components/ui/button";

const CONTACT_EMAIL = "failproofai@exosphere.host";

const options = [
  {
    label: "Star us on GitHub",
    icon: Star,
    href: "https://github.com/failproofai/failproofai",
    color: "#f5c842",
    bg: "rgba(245,200,66,0.08)",
  },
  {
    label: "Documentation",
    icon: BookOpen,
    href: "https://docs.befailproof.ai/introduction",
    color: "#60a5fa",
    bg: "rgba(96,165,250,0.08)",
  },
  {
    label: "Join our Discord",
    icon: MessageCircle,
    href: "https://discord.gg/2zjBZP7yQJ",
    color: "#5865f2",
    bg: "rgba(88,101,242,0.08)",
  },
  {
    label: "Feedback & Issues",
    icon: MessageSquareWarning,
    href: "https://github.com/FailproofAI/failproofai/issues/new/choose",
    color: "#34d399",
    bg: "rgba(52,211,153,0.08)",
  },
] as const;

export const ReachDevelopers: React.FC = () => {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  }, []);

  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={close}
          aria-hidden="true"
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative z-50 flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <GitBranch className="h-4 w-4" />
        <span className="hidden sm:inline text-xs">Reach Us</span>
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>

      {open && (
        <div className="absolute right-0 mt-2 w-60 rounded-lg border border-border bg-card shadow-xl z-50" role="menu"
          style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)" }}
        >
          <div className="px-3 py-2.5 border-b border-border"
            style={{ background: "linear-gradient(135deg, rgba(236,72,153,0.12) 0%, rgba(139,92,246,0.08) 100%)" }}
          >
            <p className="text-xs font-semibold" style={{ color: "#e879f9", letterSpacing: "0.06em" }}>Reach Developers</p>
            <p className="text-[0.65rem] text-muted-foreground mt-0.5">
              We&apos;d love to hear from you
            </p>
          </div>
          <div className="py-1">
            {options.map(({ label, icon: Icon, href, color, bg }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="flex items-center gap-2.5 px-3 py-2 text-xs transition-colors"
                style={{ color: "var(--muted-foreground)" }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.background = bg;
                  (e.currentTarget as HTMLAnchorElement).style.color = color;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.background = "";
                  (e.currentTarget as HTMLAnchorElement).style.color = "";
                }}
                onClick={close}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ color }} />
                {label}
              </a>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-border" style={{ background: "rgba(0,0,0,0.2)" }}>
            <p className="text-[0.65rem] text-muted-foreground">
              or email{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="transition-colors"
                style={{ color: "#e879f9" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.75")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "1")}
              >
                {CONTACT_EMAIL}
              </a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
