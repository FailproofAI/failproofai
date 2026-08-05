/**
 * /settings — one page, sections. The single home for the machine-level
 * controls the design plan collected here: the scheduled local audit and
 * emailed audit reports.
 *
 * Deliberately NOT a home for telemetry: the product decision is that telemetry
 * is documented but not advertised in-product, so there is no telemetry control
 * or status on this page. `config.toml` plus the docs are the whole story.
 *
 * Thin server wrapper (Suspense boundary + the disabled-pages gate every route
 * uses); all the reads/writes live in the client and its server actions.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import SettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const disabled = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (disabled.includes("settings")) notFound();

  return (
    <Suspense>
      <SettingsClient />
    </Suspense>
  );
}
