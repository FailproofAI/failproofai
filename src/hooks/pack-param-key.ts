/**
 * The config key a pack policy's parameters are stored under.
 *
 * A LEAF module on purpose: no imports at all, so it can be reached from the
 * browser. `packPolicyParamKey` used to live in `policy-evaluator.ts`, which
 * the dashboard's client component then imported — dragging `pack-store` and
 * its `node:fs` into the browser bundle and failing the Next build with
 * `Module not found: Can't resolve 'fs/promises'`. The key is pure string
 * formatting and belongs where both sides can have it.
 *
 * VERSION-LESS, and that is the whole design. A pack policy registers as
 * `pack/<id>@<version>/<name>`, so a key carrying the version would be orphaned
 * by the publisher's next release — a parameter somebody set would silently
 * revert to its default on upgrade, which is the same failure `enabled` avoids
 * by outliving the version it was chosen against.
 */
export function packPolicyParamKey(packId: string, policyName: string): string {
  return `pack/${packId}/${policyName}`;
}

/** `pack/<id>@<version>/<name>` split back into the parts a key is built from,
 *  or null when the name is not a pack policy's. */
export function parsePackPolicyName(
  canonicalName: string,
): { packId: string; name: string } | null {
  if (!canonicalName.startsWith("pack/")) return null;
  const rest = canonicalName.slice("pack/".length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;
  const idWithVersion = rest.slice(0, slash);
  const at = idWithVersion.lastIndexOf("@");
  return {
    packId: at > 0 ? idWithVersion.slice(0, at) : idWithVersion,
    name: rest.slice(slash + 1),
  };
}
