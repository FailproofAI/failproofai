/**
 * "Did you mean …?" for a command or a top-level flag the CLI does not know.
 *
 * Two sources, asked in this order:
 *
 *   1. Words people type that are not commands here, each mapped to the real
 *      command that does what they meant: `status` is `config --status`, not
 *      `flush`. The nearest-spelling guess used to answer `status` with
 *      `flush` and `install` with `uninstall` — the opposite of the request.
 *   2. The nearest real subcommand by spelling, for a typo of one.
 *
 * Both are matched within a distance cut-off, so a typo of a table word still
 * finds it (`statsu` → `config --status`), and a word that is close to nothing
 * gets NO suggestion. A guess at something unrelated sends a person to the
 * wrong command with confidence; saying nothing sends them to `help`.
 *
 * Every suggestion is a whole command, runnable exactly as printed.
 */

/** Words that are not commands here, and what to run instead. Lower case. */
const WORD_INTENTS: Readonly<Record<string, string>> = {
  status: "failproofai config --status",
  doctor: "failproofai config --status",
  whoami: "failproofai config --status",
  pause: "failproofai config --pause",
  resume: "failproofai config --resume",
  login: "failproofai config",
  signin: "failproofai config",
  "sign-in": "failproofai config",
  connect: "failproofai config",
  logout: "failproofai config --disconnect",
  disconnect: "failproofai config --disconnect",
  // `setup`, `configure`, `policy` and `pack` already RUN as their command;
  // they are here so a typo of one finds it too.
  setup: "failproofai config",
  configure: "failproofai config",
  policy: "failproofai policies",
  pack: "failproofai policies",
  install: "failproofai policies --install",
  enable: "failproofai policies add",
  disable: "failproofai policies remove",
  add: "failproofai policies add",
  list: "failproofai policies",
  ls: "failproofai policies",
  upgrade: "failproofai update",
  version: "failproofai --version",
  hook: "failproofai help hook",
  hooks: "failproofai help hook",
  dashboard: "failproofai",
  start: "failproofai",
  open: "failproofai",
  // `auth login` was the audit reminder's sign-in until it was removed; that
  // sign-in lives with the audit now.
  auth: "failproofai audit",
};

/** Top-level flags that belong to a command, and that command. */
const FLAG_INTENTS: Readonly<Record<string, string>> = {
  "--status": "failproofai config --status",
  "--pause": "failproofai config --pause",
  "--resume": "failproofai config --resume",
  "--token": "failproofai config",
  "--connect": "failproofai config",
  "--disconnect": "failproofai config --disconnect",
  "--install": "failproofai policies --install",
  "-i": "failproofai policies --install",
  "--list": "failproofai policies",
  "--all": "failproofai policies --all",
};

/** The flags that are top-level in their own right, and are typo targets. */
const TOP_LEVEL_FLAGS = ["--version", "--help"] as const;

/**
 * Edit distance with a swap of two neighbouring letters counted as ONE edit
 * (optimal string alignment) — `cofnig` is one slip from `config`, not two.
 */
function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * How far a typo may be from what it meant. Two letters or fewer must match
 * exactly — almost anything is one edit from `ls`. Up to four letters, one
 * edit; longer, two. `install` is two edits from `uninstall`, which is why the
 * word table is asked first.
 */
function typoReach(word: string): number {
  if (word.length <= 2) return 0;
  return word.length <= 4 ? 1 : 2;
}

/**
 * What `word` most likely meant among `candidates` (spelling → command), or
 * null. A word of three letters or more that starts exactly one command's
 * spelling is that command — `back` is `backfill`, though `pack` is nearer by
 * spelling. Otherwise the closest spelling within reach, the earliest one
 * winning a tie.
 */
function nearestOf(word: string, candidates: ReadonlyArray<readonly [string, string]>): string | null {
  if (word.length >= 3) {
    const prefixed = new Set(candidates.filter(([spelling]) => spelling.startsWith(word)).map(([, to]) => to));
    if (prefixed.size === 1) return [...prefixed][0];
  }
  const reach = typoReach(word);
  let best: { to: string; distance: number } | null = null;
  for (const [spelling, to] of candidates) {
    const distance = typoDistance(word, spelling);
    if (distance <= reach && (best === null || distance < best.distance)) best = { to, distance };
  }
  return best?.to ?? null;
}

/**
 * The command to suggest for an unknown word, or null when nothing is close.
 * `subcommands` is the CLI's own list, passed in so there is one copy of it.
 */
export function suggestCommand(word: string, subcommands: readonly string[]): string | null {
  const typed = word.trim().toLowerCase();
  if (!typed) return null;
  const intent = WORD_INTENTS[typed];
  if (intent) return intent;
  return nearestOf(typed, [
    ...subcommands.map((name) => [name, `failproofai ${name}`] as const),
    ...Object.entries(WORD_INTENTS),
  ]);
}

/** The one of `names` that `word` is a typo of, or null when none is close. */
export function nearestName(word: string, names: readonly string[]): string | null {
  const typed = word.trim().toLowerCase();
  if (!typed) return null;
  return nearestOf(typed, names.map((name) => [name, name] as const));
}

/** The command to suggest for an unknown top-level flag, or null when nothing is close. */
export function suggestFlag(flag: string): string | null {
  const typed = flag.trim().toLowerCase();
  // `-V` and `-H` reach here only because of their case.
  if (typed === "-v") return "failproofai --version";
  if (typed === "-h") return "failproofai --help";
  const intent = FLAG_INTENTS[typed];
  if (intent) return intent;
  // Compared without the dashes, so `-verison` and `--verison` read alike.
  const bare = (spelling: string) => spelling.replace(/^-+/, "");
  if (!bare(typed)) return null;
  return nearestOf(bare(typed), [
    ...TOP_LEVEL_FLAGS.map((name) => [bare(name), `failproofai ${name}`] as const),
    ...Object.entries(FLAG_INTENTS).map(([spelling, to]) => [bare(spelling), to] as const),
  ]);
}
