/**
 * Root layout — single dark theme, no toggle.
 *
 * Light mode was removed in #332. The `dark` class is rendered statically on
 * `<html>` so there's no theme indeterminacy and no inline script is needed.
 */
import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { PostHogProvider } from "@/contexts/PostHogContext";
import { GlobalErrorListeners } from "@/app/components/global-error-listeners";
import { AutoRefreshProvider } from "@/contexts/AutoRefreshContext";
import { Navbar } from "@/components/navbar";
import { Toaster } from "@/app/components/toast";
import "./globals.css";

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Failproof AI - Hooks & Project Monitor",
  description: "Open-source hooks, policies, and project visualization for Claude Code & Agents SDK",
  icons: {
    icon: "/icon.png",
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
    <html lang="en" className={`${geistMono.variable} dark`}>
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
