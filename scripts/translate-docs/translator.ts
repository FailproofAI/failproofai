import Anthropic from "@anthropic-ai/sdk";
import { DO_NOT_TRANSLATE } from "./config";

let client: Anthropic | null = null;

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
3. **Preserve YAML frontmatter keys** — only translate the string values of \`title\` and \`description\`. Keep the \`icon\` value unchanged.
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

export async function translateContent(
  content: string,
  targetLang: string,
  targetLangName: string,
  model: string = "claude-sonnet-4-6",
): Promise<{ translated: string; inputTokens: number; outputTokens: number }> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model,
    max_tokens: 16384,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Translate the following documentation content into ${targetLangName} (${targetLang}).\n\n---\n\n${content}`,
      },
    ],
  });

  const translated =
    response.content[0].type === "text" ? response.content[0].text : "";

  return {
    translated,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
