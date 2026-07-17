import Anthropic from "@anthropic-ai/sdk";
import { DO_NOT_TRANSLATE } from "./config";

let client: Anthropic | null = null;

// Output-token ceiling for a single translation. The largest English docs
// (e.g. agenteye/kubernetes-deployment.mdx at ~1400 lines) translate to well
// beyond the old 16384 cap for verbose target languages. When a response hit
// that cap it was silently truncated mid-MDX — leaving an unbalanced `{` or an
// unterminated JSX expression — and the partial output was written to disk and
// the cache, only to fail `mintlify validate` later in the consolidate job
// (or, for the very largest pages, to trip the proxy with a "stream ended"
// error). 64000 is Claude Haiku 4.5's max output (Tier 2/3 languages) and well
// inside Claude Sonnet 4.6's 128000 (Tier 1), with headroom over the largest
// observed translation; max_tokens is only a ceiling, so smaller pages still
// stop at `end_turn` and cost the same. Streaming (below) is what keeps an
// output this large safe from the SDK's HTTP timeout.
// Override via TRANSLATE_MAX_TOKENS (integer >= 1; otherwise default).
const parsedMaxTokens = Number.parseInt(
  process.env.TRANSLATE_MAX_TOKENS ?? "",
  10,
);
const MAX_TOKENS =
  Number.isInteger(parsedMaxTokens) && parsedMaxTokens > 0
    ? parsedMaxTokens
    : 64000;

// Maximum TOTAL validation attempts per page: 1 initial translation plus up to
// MAX_ATTEMPTS-1 re-translations when the rendered output fails validation
// (see translateValidated below). Distinct from the SDK transport budget
// TRANSLATE_MAX_RETRIES (default 5, in getClient): that retries a single HTTP
// request on a connection error; this re-translates a page whose *content*
// failed the docs-build checks. They multiply — at most
// MAX_ATTEMPTS x (1 + maxRetries) HTTP requests for one page in the worst case.
// 3 collapses the observed per-page failure rate to negligible while costing
// wall-clock (a serial retry inside one worker slot), not peak concurrency.
// Override via TRANSLATE_MAX_ATTEMPTS (integer >= 1; 1 disables retries).
const parsedMaxAttempts = Number.parseInt(
  process.env.TRANSLATE_MAX_ATTEMPTS ?? "",
  10,
);
const MAX_ATTEMPTS =
  Number.isInteger(parsedMaxAttempts) && parsedMaxAttempts > 0
    ? parsedMaxAttempts
    : 3;

function getClient(): Anthropic {
  if (!client) {
    // Default 5 retries (up from SDK default of 2) so transient
    // `Connection error.` from LiteLLM replica flapping gets enough
    // chances for the LB to route a retry to a healthy replica.
    // Override via TRANSLATE_MAX_RETRIES (integer >= 0; 0 disables retries).
    const parsed = Number.parseInt(process.env.TRANSLATE_MAX_RETRIES ?? "", 10);
    const maxRetries = Number.isInteger(parsed) && parsed >= 0 ? parsed : 5;
    client = new Anthropic({ maxRetries });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a professional technical documentation translator. Your task is to translate documentation content precisely and naturally into the target language.

## Rules

1. **Preserve all code blocks exactly as-is** — never translate content inside backtick-fenced code blocks (\`\`\`...\`\`\`) or inline code (\`...\`).
2. **Preserve MDX component syntax** — tags like <Card>, <CardGroup>, <CodeGroup>, <Steps>, <Step>, <Note>, <Tip>, <Tabs>, <Tab>, <Warning> must remain unchanged. Their attribute names (title, icon, href, cols) must remain in English. Only translate the text content of the \`title\` attribute and the text body between tags. **Never put an ASCII straight \`"\` inside a \`title="…"\` (or any JSX attribute value)** — it terminates the attribute and breaks MDX parsing. If the target language would normally wrap a word in quotation marks (e.g. German „…", Japanese 「…」), drop the inner quotes inside attribute values and rely on the surrounding tag for emphasis.
3. **Preserve YAML frontmatter keys** — only translate the string values of \`title\` and \`description\`. Keep the \`icon\` value unchanged. Never rename, add, or drop a frontmatter key. The \`title\` and \`description\` values are wrapped in double quotes: **never put an unescaped ASCII \`"\` inside them** — it terminates the YAML string and breaks the frontmatter parse (exactly as an ASCII \`"\` breaks a JSX attribute in rule 2). If the source value contains an escaped quote (\`\\"\`), keep it escaped in the same form; if the target language would quote a phrase, use typographic quotes (e.g. „…", «…», 「…」) or rephrase to avoid the inner quote.
4. **Preserve all URLs and paths** — never modify href values, image paths, or links.
5. **Preserve Markdown structure** — headers (#, ##), lists (-, *), tables (|), bold (**), italic (*), links ([text](url)) must keep their Markdown formatting.
6. **Preserve badge/shield URLs** — any [![...](https://img.shields.io/...)](url) pattern must remain completely unchanged.

## Do-not-translate list

The following terms must NEVER be translated — keep them exactly as-is in the output:
${DO_NOT_TRANSLATE.map((t) => `- ${t}`).join("\n")}

## Translation quality

- Use natural, idiomatic phrasing in the target language — do NOT produce word-for-word literal translations.
- Technical documentation should read as if originally written in the target language by a native-speaking developer.
- Maintain the same level of formality and tone as the source.
- For languages that distinguish formal/informal registers, use a professional but approachable tone.

## Output

Return ONLY the translated content. Do not add explanations, notes, or commentary.`;

export interface RetryFeedback {
  attempt: number;
  maxAttempts: number;
  /** The previous attempt's validation error — model-actionable text. */
  error: string;
}

/**
 * The repair note appended to the user turn on a retry. The failed attempt is
 * NOT fed back as an assistant turn: a fresh re-translate keeps the input flat
 * across attempts. Conversational repair would grow the input every attempt and
 * push a large README toward the max_tokens ceiling on exactly the retry where
 * a truncation would be worst — and the error is self-locating (it carries the
 * caret excerpt / body snippet), so the model needs the note, not its own prior
 * output, to fix the defect.
 */
function buildRetryFeedback(f: RetryFeedback): string {
  return (
    `[Retry ${f.attempt} of ${f.maxAttempts}. The source document above is unchanged.]\n\n` +
    "Your previous translation of this document was REJECTED by the docs build " +
    "and discarded. It failed validation with:\n\n" +
    `${f.error}\n\n` +
    "Translate the source again from the beginning and return ONLY the " +
    "corrected translation — do not comment on this note. Do not reproduce that " +
    "defect. Every rule above still applies."
  );
}

export async function translateContent(
  content: string,
  targetLang: string,
  targetLangName: string,
  model: string = "claude-sonnet-4-6",
  feedback?: RetryFeedback,
): Promise<{ translated: string; inputTokens: number; outputTokens: number }> {
  const anthropic = getClient();

  // Streaming so we don't hit AWS Bedrock's 300s synchronous InvokeModel
  // ceiling on the largest Tier-1 (Sonnet) translations. Bedrock is one of
  // the two upstream deployments behind models.aikin.club's
  // claude-sonnet-4-6 route (weighted 1:1 with anthropic-direct). Under
  // load, a 6k-token output exceeds Bedrock's non-streaming wall and
  // surfaces to the SDK as `APIConnectionError ("Connection error.")`.
  // `messages.stream(...).finalMessage()` returns the same Message shape
  // as `messages.create(...)`, so the rest of the pipeline is unchanged.
  const base = `Translate the following documentation content into ${targetLangName} (${targetLang}).\n\n---\n\n${content}`;
  // On a retry, append the repair note after the source in the SAME single user
  // turn — no assistant turn is fed back, so the request stays flat-input.
  const userContent = feedback
    ? `${base}\n\n---\n\n${buildRetryFeedback(feedback)}`
    : base;

  const response = await anthropic.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  }).finalMessage();

  // A truncated translation is worse than a failed one: the model stops
  // mid-MDX, and that partial would otherwise be written to disk and cached as
  // if complete, surfacing only as an unbalanced-brace parse error in
  // `mintlify validate`. Fail loudly instead so the caller (cli.ts) records an
  // error, never caches the partial, and excludes this language from the
  // consolidate publish step. If a page ever legitimately needs more than
  // MAX_TOKENS, raise TRANSLATE_MAX_TOKENS or split the source.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `translation truncated at max_tokens=${MAX_TOKENS} ` +
        `(output ${response.usage.output_tokens} tokens) — source too large to translate in one request`,
    );
  }

  const translated =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  return {
    translated,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Translate `source`, render it to the exact bytes that will be written, and
 * validate those bytes — re-translating with the validation error fed back
 * until it passes or MAX_ATTEMPTS is reached.
 *
 * The loop lives here, not in translateContent, because each caller renders
 * different final bytes (the MDX pages add rewriteInternalLinks; the README
 * wraps the body in a disclaimer + RTL `<div>`). Validating the RENDERED bytes —
 * not the raw model output — is what makes a pass here equal to a pass in
 * `mintlify validate` and the deploy.
 *
 * On exhaustion it THROWS (never returns a partial), so the caller's write is
 * unreachable and no invalid page is ever written or cached — the same
 * fail-loud contract translateContent already enforces for max_tokens
 * truncation. Transport/auth/max_tokens errors from translateContent propagate
 * unchanged and consume no attempt: only *validity* failures retry.
 */
export async function translateValidated(opts: {
  source: string;
  lang: string;
  langName: string;
  model?: string;
  /** Label for the per-attempt warning line, e.g. `agenteye/cli.mdx [de]`. */
  label: string;
  /** Turn raw model output into the exact bytes that will be written. */
  render: (raw: string) => string;
  /** Validate the rendered bytes; return an error message, or null if valid. */
  validate: (rendered: string) => Promise<string | null>;
}): Promise<{
  rendered: string;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}> {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const feedback: RetryFeedback | undefined =
      attempt > 1
        ? { attempt, maxAttempts: MAX_ATTEMPTS, error: lastError }
        : undefined;

    // No try/catch: a transport/auth/max_tokens throw is not a validity
    // failure — let it propagate so it is never silently retried as one.
    const result = await translateContent(
      opts.source,
      opts.lang,
      opts.langName,
      opts.model,
      feedback,
    );
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (result.translated.trim() === "") {
      // An empty response is a validity failure, not a usable page — resample
      // rather than write a blank file.
      lastError =
        "The translation was empty. Return the full translated document.";
      console.warn(
        `  ${opts.label} -> attempt ${attempt}/${MAX_ATTEMPTS} produced empty output; retrying`,
      );
      continue;
    }

    const rendered = opts.render(result.translated);
    const error = await opts.validate(rendered);
    if (error === null) {
      return { rendered, inputTokens, outputTokens, attempts: attempt };
    }

    lastError = error;
    console.warn(
      `  ${opts.label} -> attempt ${attempt}/${MAX_ATTEMPTS} failed validation: ${error.split("\n")[0]}`,
    );
  }

  throw new Error(
    `translation into ${opts.langName} (${opts.lang}) still fails validation ` +
      `after ${MAX_ATTEMPTS} attempt(s): ${lastError.split("\n")[0]}`,
  );
}
