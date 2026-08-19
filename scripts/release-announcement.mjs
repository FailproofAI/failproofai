/**
 * Build the Discord webhook payload for a STABLE release.
 *
 * Called by the `announce` job in `.github/workflows/publish.yml`, after the
 * registry check and the four `verify-install` legs have proved the release is
 * real.
 *
 * **The GitHub Release body is the source of record; CHANGELOG.md is the
 * fallback.** Stable releases are cut from the GitHub Releases page, and the
 * notes written there are what the maintainer decided this release says —
 * chosen for an audience, ordered on purpose, sometimes rewritten from the
 * changelog entirely. Announcing from CHANGELOG.md instead would publish a
 * DIFFERENT summary than the one on the release page, in the channel where more
 * people read it. So the body wins whenever there is one, and the changelog
 * covers the two cases where there is not: an empty release body, and a
 * `workflow_dispatch` build, which has no release event at all.
 *
 * Three other things are load-bearing and easy to get wrong:
 *
 * **From the changelog, a stable release carries its whole beta line.** Somebody
 * on `latest` moving 1.0.0 -> 1.0.1 receives everything that shipped across
 * `1.0.1-beta.*` as well as whatever the release commit itself carried, and the
 * `## 1.0.1` section deliberately does NOT restate it ("Everything below this
 * heading shipped across the `1.0.0-beta.*` line" — the 1.0.0 section says so
 * in as many words). Announcing only the stable section would describe a
 * release as a handful of entries when it is forty, so `collectRelease` gathers
 * `## <version>` and every `## <version>-*` section under it and merges them.
 *
 * **Only the first sentence of an entry survives.** This changelog's entries are
 * paragraphs — several are over 2000 characters, which is the entire Discord
 * message limit on its own. The first sentence is written as a headline in
 * every entry in the file, so it is the one summary already there rather than
 * one this script invents. GitHub's own generated notes are one PR title per
 * bullet, so the same pass leaves them untouched.
 *
 * **The mention goes in `content`, never in the embed.** Discord does not
 * resolve mentions inside embeds — a `<@&id>` there renders as the raw string
 * and pings nobody. Paired with `allowed_mentions: {parse: [], roles: [id]}`
 * so that the release role is the ONLY thing that can be pinged: release notes
 * reach the embed unescaped, and `parse: []` is what stops an `@everyone` in
 * them from becoming one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The brand pink — `HUES.pink` in `src/hooks/tui.ts`, as Discord's integer. */
export const BRAND_COLOR = 0xff2e88;

/**
 * Entries under these headings are left out of the embed. A notification is
 * not the changelog; it links to it. Dependency bumps are the one category
 * nobody reads a release announcement for, and they routinely outnumber
 * everything else. `collectRelease` still counts them, so the "+N more" line
 * stays honest, and a release that is ONLY dependency bumps falls back to
 * showing them rather than announcing nothing.
 */
const DEPRIORITIZED_GROUPS = new Set(["dependencies"]);

/** Highlights shown per heading before the rest collapse into a "+N more". */
const MAX_ENTRIES_PER_GROUP = 6;

/** A headline longer than this is cut at a word boundary. */
const MAX_HEADLINE = 180;

/** How much of a stable section's prose preamble reaches the embed. */
const MAX_LEAD = 600;

// Discord's documented maxima. Exceeding any one of them is a 400 from the
// webhook, i.e. a release that publishes fine and announces nothing.
const LIMIT_CONTENT = 2000;
const LIMIT_DESCRIPTION = 4096;
const LIMIT_FIELD_VALUE = 1024;
const LIMIT_TITLE = 256;
const LIMIT_EMBED_TOTAL = 6000;

// ── Changelog parsing ───────────────────────────────────────────────────────

/**
 * Split `CHANGELOG.md` into `## <version> — <date>` sections.
 *
 * The separator is matched as em dash, en dash or hyphen because the file is
 * hand-written and a heading is exactly the kind of line where that slips. The
 * date is optional for the same reason: a heading with no date is still a
 * release, and refusing to parse it would take the announcement down over
 * punctuation.
 *
 * Sections are returned in FILE order (newest first) and duplicate versions are
 * kept as separate sections — the file genuinely carries two `## 1.0.0-beta.13`
 * headings and two `## 1.0.0-beta.15` headings, and dropping either would drop
 * real entries. `collectRelease` merges them.
 */
export function parseChangelog(text) {
  const lines = String(text).split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^##\s+(\S+)\s*(?:[—–-]\s*(.*))?$/.exec(line);
    if (heading) {
      current = { version: heading[1], date: (heading[2] ?? "").trim(), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  return sections.map((s) => ({ ...s, body: s.body.join("\n") }));
}

/**
 * Split a section body into `### <name>` groups plus any prose that precedes
 * the first one.
 *
 * Bullets are joined across continuation lines: an entry runs until the next
 * line that starts a new bullet or a new heading. Every entry in this file is
 * currently one long line, which is exactly why a wrapped one would otherwise
 * be silently truncated at the wrap.
 */
export function parseSectionBody(body) {
  const lines = String(body).split(/\r?\n/);
  const lead = [];
  const groups = [];
  let group = null;
  let entry = null;

  const flush = () => {
    if (entry !== null && group) group.entries.push(entry.join(" ").trim());
    entry = null;
  };

  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      group = { name: heading[1], entries: [] };
      groups.push(group);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet && group) {
      flush();
      entry = [bullet[1]];
      continue;
    }

    if (entry !== null) {
      // A blank line ends an entry; anything else continues it.
      if (line.trim() === "") flush();
      else entry.push(line.trim());
      continue;
    }

    if (!group) lead.push(line);
  }
  flush();

  return { lead: lead.join("\n").trim(), groups };
}

/**
 * Gather the stable section for `version` plus every prerelease section under
 * it, merging groups of the same name.
 *
 * Merging by name is not tidiness: `1.0.1-beta.2` carries TWO `### Fixes`
 * headings, so keying on the heading text is what keeps the second one's
 * entries from replacing the first one's — and what keeps `Fixes` from
 * appearing twice in the embed.
 *
 * Only the stable section's prose preamble is kept. A beta's preamble is
 * written for people tracking betas, and stacking four of them would bury the
 * entries.
 */
export function collectRelease(changelogText, version) {
  const sections = parseChangelog(changelogText);
  const mine = sections.filter((s) => s.version === version || s.version.startsWith(`${version}-`));
  if (mine.length === 0) return null;

  const byName = new Map();
  let lead = "";
  let date = "";

  for (const section of mine) {
    const parsed = parseSectionBody(section.body);
    if (section.version === version) {
      if (!lead) lead = parsed.lead;
      if (!date) date = section.date;
    }
    for (const group of parsed.groups) {
      const key = group.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: group.name.trim(), entries: [] });
      byName.get(key).entries.push(...group.entries);
    }
  }

  const groups = [...byName.values()].map((g) => ({
    name: g.name,
    entries: g.entries.map(summarizeEntry),
  }));

  return {
    version,
    date,
    lead,
    groups,
    total: groups.reduce((n, g) => n + g.entries.length, 0),
    sections: mine.map((s) => s.version),
  };
}

/**
 * A GitHub Release body -> the same `{lead, groups, total}` shape a changelog
 * section produces, so everything downstream is source-agnostic.
 *
 * Two shapes arrive here and both have to work:
 *
 *   * **GitHub's generated notes** — `## What's Changed`, then one
 *     `* <PR title> by @someone in <pull url>` per merged PR, then a
 *     `**Full Changelog**: <compare url>` line. The trailing attribution is
 *     stripped and the pull URL becomes the `#NNN` link, because "by @x in
 *     https://github.com/…/pull/123" is 60 characters of noise per line in a
 *     message with a 4096-character budget.
 *
 *   * **Hand-written notes** — arbitrary markdown, usually `###` sections with
 *     `-` bullets, which is the changelog's own shape.
 *
 * Notes with no headings at all are still notes: their bullets land in one
 * unnamed group rather than being dropped, and prose with no bullets at all
 * becomes the lead. The empty case returns null so the caller can fall back.
 */
export function parseReleaseBody(text) {
  const body = String(text ?? "").trim();
  if (!body) return null;

  const lead = [];
  const groups = [];
  let group = null;
  let entry = null;
  let compareUrl = null;

  const flush = () => {
    if (entry !== null) {
      const joined = entry.join(" ").trim();
      if (joined) {
        if (!group) {
          group = { name: "Highlights", entries: [] };
          groups.push(group);
        }
        group.entries.push(joined);
      }
    }
    entry = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      group = { name: heading[1].replace(/^what's changed$/i, "Changes"), entries: [] };
      groups.push(group);
      continue;
    }

    // GitHub appends this to every generated body. We render our own link, and
    // a compare URL is a better one than a blob URL when it is offered.
    const full = /^\*{0,2}Full Changelog\*{0,2}:\s*(\S+)\s*$/i.exec(line.trim());
    if (full) {
      flush();
      compareUrl = full[1];
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      entry = [bullet[1]];
      continue;
    }

    if (entry !== null) {
      if (line.trim() === "") flush();
      else entry.push(line.trim());
      continue;
    }

    if (!group) lead.push(line);
  }
  flush();

  const parsed = groups
    .map((g) => ({ name: g.name, entries: g.entries.map(summarizeEntry) }))
    .filter((g) => g.entries.length > 0);

  const leadText = lead.join("\n").trim();
  if (parsed.length === 0 && !leadText) return null;

  return {
    lead: leadText,
    groups: parsed,
    total: parsed.reduce((n, g) => n + g.entries.length, 0),
    compareUrl,
    sections: ["the GitHub Release body"],
  };
}

/**
 * Pick the source and return the notes, or null when neither has anything.
 * The precedence — release body, then changelog — is the whole point; see the
 * module header.
 */
export function chooseNotes({ releaseBody, changelog, version }) {
  return (
    parseReleaseBody(releaseBody) ??
    (changelog ? collectRelease(changelog, version) : null)
  );
}

// ── Entry summarizing ───────────────────────────────────────────────────────

/**
 * Abbreviations whose trailing period does not end a sentence. Without these,
 * "e.g. the daemon" splits after "e.g." and the headline is two words long.
 */
const ABBREVIATIONS = new Set(["e.g", "i.e", "cf", "vs", "etc", "approx", "incl", "no", "fig"]);

/**
 * The first sentence of `text`, with inline code spans protected.
 *
 * Periods are everywhere in this changelog that are not sentence ends —
 * `policy-evaluator.ts`, `1.0.15`, `~/.failproofai/run/` — and almost all of
 * them sit inside backticks, so the spans are masked before the search and
 * restored after. What is left is a period (or `!`/`?`) that may be followed by
 * closing emphasis (`**`, `_`, `` ` ``, `)`, `"`), then whitespace, then the
 * start of a new sentence. Entries in this file routinely open with a whole
 * bolded sentence — `**Stop the digest shipping secrets verbatim.**` — which is
 * why the closing markers have to be consumed before the boundary, not after.
 *
 * A candidate boundary that would leave less than `MIN_SENTENCE` characters is
 * skipped: it is nearly always a false positive on an initial or a stray
 * abbreviation, and a six-character headline is worse than a long one. The
 * length is measured on the RESTORED text — an entry opening with a long path
 * in backticks masks down to three characters, and measuring the masked form
 * rejected every real boundary after it.
 */
export function firstSentence(text) {
  const MIN_SENTENCE = 12;
  const spans = [];
  const masked = String(text).replace(/`[^`]*`/g, (m) => {
    spans.push(m);
    return ` ${spans.length - 1} `;
  });
  const restore = (s) => s.replace(/ (\d+) /g, (_, i) => spans[Number(i)]);

  const boundary = /([.!?])([*_`)"'\]]*)(\s+)/g;
  let match;
  while ((match = boundary.exec(masked)) !== null) {
    const end = match.index + match[1].length + match[2].length;
    const candidate = restore(masked.slice(0, end)).trim();
    if (candidate.length < MIN_SENTENCE) continue;

    const before = masked.slice(0, match.index);
    const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? "";
    if (ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ""))) continue;

    // A lone capital before the period is an initial ("J. Smith"), not an end.
    if (/(^|\s)[A-Z]$/.test(before)) continue;

    return candidate;
  }

  return restore(masked).trim();
}

/** Cut at a word boundary, so a headline never ends mid-token. */
export function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

/**
 * One entry — from either source — into `{headline, pr}`.
 *
 * The PR reference is read off the END of the WHOLE entry before the first
 * sentence is taken, because that is where it lives in both formats and the
 * first sentence never contains it. Three trailing forms are recognised: the
 * changelog's `(#123)`, GitHub's `by @someone in <pull url>`, and a bare pull
 * URL. `(#PR)` and other non-numeric placeholders yield no link rather than a
 * broken one.
 */
export function summarizeEntry(entry) {
  let text = String(entry).trim();
  let pr = null;

  const attribution = /\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S*?\/pull\/(\d+)\/?\s*$/i.exec(text);
  const bareUrl = /\s+https?:\/\/\S*?\/pull\/(\d+)\/?\s*$/i.exec(text);
  const parenRef = /\(#(\d+)\)\s*$/.exec(text);

  if (attribution) {
    pr = Number(attribution[1]);
    text = text.slice(0, attribution.index);
  } else if (bareUrl) {
    pr = Number(bareUrl[1]);
    text = text.slice(0, bareUrl.index);
  } else if (parenRef) {
    pr = Number(parenRef[1]);
  }

  return {
    headline: truncate(firstSentence(text.replace(/\s*\(#[^)]*\)\s*$/, "")), MAX_HEADLINE),
    pr,
  };
}

// ── Payload ─────────────────────────────────────────────────────────────────

/**
 * Order the groups for display: the deprioritized ones last, everything else in
 * the order the changelog introduced it. Returns `[shown, hiddenCount]`.
 */
function selectGroups(groups) {
  const kept = groups.filter((g) => g.entries.length > 0);
  const primary = kept.filter((g) => !DEPRIORITIZED_GROUPS.has(g.name.toLowerCase()));
  // A release that is nothing but dependency bumps still gets a description.
  const shown = primary.length > 0 ? primary : kept;
  const hidden = kept
    .filter((g) => !shown.includes(g))
    .reduce((n, g) => n + g.entries.length, 0);
  return [shown, hidden];
}

/**
 * Assemble the description within `budget`, dropping WHOLE groups rather than
 * cutting mid-sentence, and always ending on the changelog link.
 *
 * The link is the part that must survive: everything above it is a sample, and
 * the link is what makes the sample honest. The first version of this appended
 * it and then truncated the finished string, which on a release the size of
 * 1.0.0 cut the link off and ended the message on "Stop sending anything about
 * a…" — a notification that showed a third of a release and pointed nowhere.
 *
 * The tail line states what was left out, counted rather than implied, so a
 * reader can tell "that was everything" from "that was the first six".
 *
 * @param {{
 *   lead: string,
 *   blocks: Array<{text: string, entries: number}>,
 *   deprioritized: number,
 *   changelogUrl: string,
 *   budget: number,
 * }} options
 */
export function fitDescription({ lead, blocks, deprioritized, changelogUrl, budget }) {
  const tailFor = (dropped) => {
    const notes = [];
    if (dropped > 0) notes.push(`${dropped} more entr${dropped === 1 ? "y" : "ies"}`);
    if (deprioritized > 0) notes.push(`${deprioritized} dependency update${deprioritized === 1 ? "" : "s"}`);
    const suffix = notes.length > 0 ? ` — ${notes.join(" and ")} not shown` : "";
    return `[Full changelog](${changelogUrl})${suffix}`;
  };

  const total = blocks.reduce((n, b) => n + b.entries, 0);
  const parts = lead ? [lead] : [];
  let used = 0;

  for (const block of blocks) {
    const candidate = [...parts, block.text, tailFor(total - used - block.entries)].join("\n\n");
    if (candidate.length > budget) break;
    parts.push(block.text);
    used += block.entries;
  }

  const out = [...parts, tailFor(total - used)].join("\n\n");
  // A lead long enough to crowd out every group is the only way to still be
  // over budget here, and cutting it is preferable to dropping the link.
  return out.length <= budget ? out : `${truncate(lead, Math.max(0, budget - tailFor(total).length - 2))}\n\n${tailFor(total)}`;
}

function renderGroup(group, repo) {
  const lines = [`**${group.name}**`];
  for (const entry of group.entries.slice(0, MAX_ENTRIES_PER_GROUP)) {
    const link = entry.pr ? ` ([#${entry.pr}](https://github.com/${repo}/pull/${entry.pr}))` : "";
    lines.push(`• ${entry.headline}${link}`);
  }
  const rest = group.entries.length - MAX_ENTRIES_PER_GROUP;
  if (rest > 0) lines.push(`• …and ${rest} more`);
  return lines.join("\n");
}

/**
 * Assemble the webhook body.
 *
 * `notes` may be null — a stable release with notes in neither source is a
 * mistake `publish.yml` checks for at preflight, but the announcement still
 * goes out without highlights rather than not at all. The release has already
 * shipped by the time this runs; silence is the worse failure.
 *
 * @param {{
 *   version: string,
 *   repo: string,
 *   notes: ReturnType<typeof collectRelease> | ReturnType<typeof parseReleaseBody>,
 *   roleId?: string | null,
 *   releaseUrl?: string | null,
 *   timestamp?: string | null,
 * }} options
 */
export function buildDiscordPayload({
  version,
  repo,
  notes,
  roleId = null,
  releaseUrl = null,
  timestamp = null,
}) {
  const tag = `v${version}`;
  const release = releaseUrl || `https://github.com/${repo}/releases/tag/${tag}`;
  const mention = roleId ? `<@&${roleId}> ` : "";

  // Only the FIRST paragraph of a stable section's preamble. 1.0.0's runs to
  // four, and flattening them all into the description produced a wall of prose
  // above the entries anybody opened the message to read.
  const lead = notes?.lead ? truncate(notes.lead.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " "), MAX_LEAD) : "";
  const [shown, deprioritized] = notes ? selectGroups(notes.groups) : [[], 0];

  // A generated release body ends on a compare link, which says more than a
  // blob link to the file does. Without one, the changelog at this tag.
  const changelogUrl = notes?.compareUrl || `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`;
  const blocks = shown.map((g) => ({ text: renderGroup(g, repo), entries: g.entries.length }));

  const description = fitDescription({
    lead,
    blocks,
    deprioritized,
    changelogUrl,
    budget: LIMIT_DESCRIPTION,
  });

  const embed = {
    title: truncate(`failproofai ${tag}`, LIMIT_TITLE),
    url: release,
    color: BRAND_COLOR,
    description,
    fields: [
      {
        name: "Install",
        value: truncate("```sh\nnpm install -g failproofai\n```", LIMIT_FIELD_VALUE),
      },
      {
        name: "Links",
        value: truncate(
          [
            `[Release notes](${release})`,
            `[npm](https://www.npmjs.com/package/failproofai/v/${version})`,
            "[Docs](https://docs.befailproof.ai/)",
          ].join(" · "),
          LIMIT_FIELD_VALUE,
        ),
      },
    ],
    footer: { text: `published from ${repo}` },
  };
  if (timestamp) embed.timestamp = timestamp;

  // Discord's 6000-character ceiling is over the SUM of an embed's text fields,
  // which no single limit above covers. Everything but the description is fixed
  // and small, so the description is re-fitted against what is left rather than
  // chopped — same rule as above, the changelog link outlives the cut.
  const fixed = embed.title.length + embed.footer.text.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (fixed + embed.description.length > LIMIT_EMBED_TOTAL) {
    embed.description = fitDescription({
      lead,
      blocks,
      deprioritized,
      changelogUrl,
      budget: Math.max(0, LIMIT_EMBED_TOTAL - fixed),
    });
  }

  return {
    content: truncate(`${mention}**failproofai ${tag}** is out.`, LIMIT_CONTENT),
    // `parse: []` is the guard, not the roles list: it stops @everyone/@here
    // and any user mention that changelog prose happens to contain. The role
    // is then re-allowed by id, so exactly one thing in this message pings.
    allowed_mentions: { parse: [], roles: roleId ? [String(roleId)] : [] },
    embeds: [embed],
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else out[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

export function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  const version = args.version;
  const repo = args.repo || process.env.GITHUB_REPOSITORY || "failproof-ai/failproofai";
  if (!version) {
    io.error(
      "usage: release-announcement.mjs --version <x.y.z> [--repo owner/name] [--notes-file FILE] " +
        "[--role-id ID] [--release-url URL] [--out FILE] [--check]",
    );
    process.exitCode = 1;
    return null;
  }

  // The release body arrives as a FILE, never as an argument. It is arbitrary
  // markdown a human typed into a web form, and putting it on a command line
  // (or into a shell string) is how a backtick in someone's release notes
  // becomes command substitution in the release pipeline.
  const notesPath = args["notes-file"] && args["notes-file"] !== "true" ? args["notes-file"] : null;
  const releaseBody = notesPath && existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";

  const changelogPath = args.changelog || resolve(REPO_ROOT, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const notes = chooseNotes({ releaseBody, changelog, version });
  const source = parseReleaseBody(releaseBody) ? "the GitHub Release body" : `${changelogPath}`;

  // `--check` is publish.yml's preflight gate: it answers "will this release
  // have anything to announce" before anything is built, which is the one point
  // in the pipeline where the answer "no" is nearly free to act on.
  if (args.check === "true") {
    if (!notes) {
      io.error(
        `::error file=CHANGELOG.md::Nothing to announce for ${version}: the GitHub Release body is ` +
          `empty and CHANGELOG.md has no '## ${version}' section. A stable release announces itself ` +
          `in Discord, so it would post with no release notes in it. Write the release notes, or add ` +
          `the changelog section, and re-run.`,
      );
      process.exitCode = 1;
      return null;
    }
    io.error(`${version} has release notes (${notes.total} entries, from ${source}).`);
    return notes;
  }

  if (!notes) {
    // A warning rather than an error: the release is already on npm by the
    // time this runs, and an announcement with no highlights still tells
    // people the version exists and how to install it.
    io.error(`::warning::No release notes for ${version} in the release body or ${changelogPath} — announcing without highlights.`);
  } else {
    io.error(`Collected ${notes.total} entr${notes.total === 1 ? "y" : "ies"} from ${source}.`);
  }

  const payload = buildDiscordPayload({
    version,
    repo,
    notes,
    roleId: args["role-id"] && args["role-id"] !== "true" ? args["role-id"] : null,
    releaseUrl: args["release-url"] && args["release-url"] !== "true" ? args["release-url"] : null,
    timestamp: args.timestamp && args.timestamp !== "true" ? args.timestamp : new Date().toISOString(),
  });

  const json = JSON.stringify(payload, null, 2);
  if (args.out && args.out !== "true") {
    writeFileSync(args.out, json);
    io.error(`Wrote ${args.out} (${json.length} bytes).`);
  } else {
    io.log(json);
  }
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
