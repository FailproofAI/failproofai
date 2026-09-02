/**
 * Path-risk regexes, shared by the builtins that enforce on them and by the
 * batch-collapse fallback that has to decide WHICH path survives a collapse.
 *
 * They live here rather than in builtin-policies.ts for two reasons:
 *
 *   1. A second hand-maintained copy is exactly how a bypass gets reintroduced:
 *      someone tightens `SECRET_FILE_RE` in the builtin and the collapse
 *      fallback keeps probing the old shape, so the riskiest path stops being
 *      picked and a `.pem` write rides through on a batch.
 *   2. `tool-name-canonicalize.ts` is on the AUDIT path, and builtin-policies.ts
 *      imports `node:child_process`. Importing the builtins from there to reach
 *      four regexes would drag the policy engine into transcript replay.
 *
 * Zero imports, on purpose. Keep it that way.
 */

/** `.env`, `.env.local`, `path/to/.env` — but not `something.environment`. */
export const ENV_FILE_PATH_RE = /(?:^|[\\/])\.env(?:\.|$)/;

/** NOTE the `$` anchor: this can only ever match at the END of a string, which
 *  is why joining a list of paths and testing the join is a SILENT BYPASS —
 *  only the last element could match. See pickRiskiestPath in batch-expand.ts. */
export const SECRET_FILE_RE = /\.(?:pem|key)$/;
export const SECRET_FILE_ID_RSA_RE = /id_rsa/;
export const SECRET_FILE_CREDENTIALS_RE = /credentials/;
