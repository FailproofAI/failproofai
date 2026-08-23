"use server";

/**
 * Installing and managing policy packs from the local dashboard.
 *
 * These are USER-INITIATED actions, which is what makes it acceptable for
 * `addPack` to import the pack's artifact here: it verifies that what a
 * publisher declared is what their code registers, and refusing at install time
 * is the whole reason a broken pack cannot brick the machine. `get-hooks-config`
 * deliberately does the opposite — it lists packs from `installed.json` and
 * imports nothing, because that runs on every page load.
 */
import { addPack, installBundledPack, removePack, setPackPolicyEnabled } from "@/src/hooks/pack-store";
import { readHooksConfig, writeHooksConfig } from "@/src/hooks/hooks-config";
import { readInstalledPacks } from "@/src/hooks/pack-manifest";

export interface PackActionResult {
  ok: boolean;
  /** Present when ok — what landed, so the UI can say it without a refetch. */
  id?: string;
  version?: string;
  enabled?: string[];
  available?: string[];
  /** Present when not ok — the publisher's or the loader's own words. */
  error?: string;
}

/** Install a pack by the source a person typed: `acme/ops`, `acme/ops@v1.2.0`, or a release URL. */
export async function addPackWebAction(
  source: string,
  opts?: { all?: boolean; only?: string[]; categories?: string[] },
): Promise<PackActionResult> {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, error: "Enter a pack source, for example acme/ops" };
  try {
    const result = await addPack(trimmed, opts ?? {});
    return {
      ok: true,
      id: result.id,
      version: result.version,
      enabled: result.enabled,
      available: result.available,
    };
  } catch (err) {
    // Surfaced verbatim. Every refusal on this path already names what was wrong
    // and whose fault it is — an unresolvable source, a digest that does not
    // match, a manifest declaring a policy its artifact never registers.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Install the pack that ships inside this package. No network. */
export async function addBundledPackWebAction(): Promise<PackActionResult> {
  const result = installBundledPack();
  if (!result.installed) return { ok: false, error: result.reason ?? "could not install" };
  return {
    ok: true,
    id: result.id,
    version: result.version,
    enabled: result.enabled,
    available: result.available,
  };
}

export async function removePackWebAction(id: string): Promise<PackActionResult> {
  return removePack(id) ? { ok: true, id } : { ok: false, error: `No installed pack with id ${id}` };
}

/**
 * Turn one policy of an installed pack on or off.
 *
 * Writes the pack's own SELECTION, the same lever the CLI uses — not a
 * `disabledCustomPolicies` entry, which is keyed by version and would silently
 * switch everything back on at the next upgrade. Enabling also clears any such
 * key, so a policy switched off before this existed can still be switched back on.
 */
export async function togglePackPolicyAction(
  packId: string,
  name: string,
  enabled: boolean,
): Promise<PackActionResult> {
  const result = setPackPolicyEnabled(packId, name, enabled);
  if (!result.ok) return { ok: false, error: result.reason };
  if (enabled) {
    const pack = readInstalledPacks().packs.find((p) => p.id === packId);
    if (pack) {
      const key = `pack:${pack.id}@${pack.version}:${name}`;
      const config = readHooksConfig();
      const remaining = (config.disabledCustomPolicies ?? []).filter((k) => k !== key);
      if (remaining.length !== (config.disabledCustomPolicies ?? []).length) {
        const { disabledCustomPolicies: _dropped, ...rest } = config;
        writeHooksConfig(
          remaining.length > 0 ? { ...rest, disabledCustomPolicies: remaining } : rest,
        );
      }
    }
  }
  return { ok: true, id: packId };
}
