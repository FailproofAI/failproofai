/**
 * Root layout — single dark theme, no toggle.
 *
 * Light mode was removed in #332. The `dark` class is rendered statically on
 * `<html>` so there's no theme indeterminacy and no inline script is needed.
 */
import type { Metadata } from "next";
import { PostHogProvider } from "@/contexts/PostHogContext";
import { GlobalErrorListeners } from "@/app/components/global-error-listeners";
import { AutoRefreshProvider } from "@/contexts/AutoRefreshContext";
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/app/components/toast";
import "./globals.css";

// Site-wide mono font is JetBrains Mono, loaded via the Google Fonts @import
// at the top of globals.css alongside the audit display font. Keeping the
// import in CSS (rather than next/font) is intentional so the same stylesheet
// is the single source of truth — see the design-system note in globals.css.

export const metadata: Metadata = {
  title: "Failproof AI - Hooks & Project Monitor",
  description: "Open-source hooks, policies, and project visualization for Claude Code & Agents SDK",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const disabledPages = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <PostHogProvider>
          <GlobalErrorListeners />
          <AutoRefreshProvider>
            <Navbar disabledPages={disabledPages} />
            {children}
          </AutoRefreshProvider>
          <Toaster />
        </PostHogProvider>
      </body>
    </html>
  );
}
