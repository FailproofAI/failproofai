> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**अनुवाद:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**कोडिंग एजेंट्स के लिए रनटाइम विफलता समाधान।**
Claude Code और Codex में हुक करता है। लूप्स, खतरनाक कार्यों, और सीक्रेट लीक्स को
उन्हें घटनाओं में बदलने से पहले पकड़ता है। शून्य लेटेंसी। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित एजेंट CLIs

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

> एक या किसी भी संयोजन के लिए हुक इंस्टॉल करें: `failproofai policies --install --cli opencode pi` (या `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`)। स्वचालित रूप से संस्थापित CLIs का पता लगाने और संकेत देने के लिए `--cli` को छोड़ दें।
>
> **Hermes** (hermes-agent, एक Slack/Telegram गेटवे) **लाइव-हुक प्रवर्तन** (`--cli hermes` — एक इंस्टॉल हर प्लेटफॉर्म और सबएजेंट से टूल कॉल को रोकता है) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके गेटवे सेशन का एकल `~/.hermes/state.db` से।
>
> **OpenClaw** (openclaw गेटवे, एक self-hosted मल्टी-चैनल असिस्टेंट) **लाइव-हुक प्रवर्तन** (`--cli openclaw`, यूजर-स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके JSONL सेशन का (`~/.openclaw/agents/<id>/sessions/*.jsonl`)। प्रवर्तन OpenClaw के **in-process प्लगइन हुक्स** का उपयोग करता है (एक shipped `openclaw-plugin/` जो async-spawns failproofai — इसकी फाइल-आधारित आंतरिक हुक्स केवल अवलोकन हैं और ब्लॉक नहीं कर सकते): `before_tool_call` एक टूल को ब्लॉक करता है, और `before_agent_finalize` एक असली turn-end गेट है, इसलिए `require-*-before-stop` बिल्ट-इन्स को प्रवर्तित करते हैं।
>
> **Factory Droid** (`droid`) **लाइव-हुक प्रवर्तन** (`--cli factory`, यूजर + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके ऑन-डिस्क JSONL सेशन का। droid हुक **exit code 2** (JSON निर्णय नहीं) को ब्लॉक करता है और `{decision:"block"}` को turn-end `Stop` event पर ही मानता है — failproofai स्वचालित रूप से प्रत्येक event के लिए सही आकार उत्सर्जित करता है।
>
> **Devin CLI** (`devin`, Cognition) **लाइव-हुक प्रवर्तन** (`--cli devin`, यूजर + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके SQLite सेशन का (`~/.local/share/devin/cli/sessions.db`)। Devin एक **शुद्ध Claude-क्लोन** है — समान event नाम, समान snake_case payload, समान `hooks`-wrapper config (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — `{decision:"block"}` JSON के माध्यम से प्रत्येक event पर ब्लॉकिंग।
>
> **Antigravity CLI** (`agy`) **लाइव-हुक प्रवर्तन** (`--cli antigravity`, यूजर + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके प्लेन-JSONL सेशन का (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`)। Antigravity का अपना **contract** है (Claude-क्लोन नहीं): एक **नामित-हुक** `hooks.json` स्कीमा (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), एक camelCase stdin payload जिसे failproofai सामान्य करता है, और अपने स्वयं के प्रतिक्रिया आकार — `{decision:"deny"}` एक टूल को ब्लॉक करने के लिए, `{decision:"continue"}` को `Stop` पर दूसरी turn को बाध्य करने के लिए, `{injectSteps}` मॉडल चलाने से पहले एक अनुस्मारक इंजेक्ट करने के लिए।
>
> **Goose** (codename goose, Block) **लाइव-हुक प्रवर्तन** (`--cli goose`, यूजर + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है इसके SQLite सेशन का (`~/.local/share/goose/sessions/sessions.db`)। प्रवर्तन Goose की **hooks** सिस्टम का उपयोग करता है (cross-agent **Open Plugins** spec) — इंस्टॉलर बस एक प्लगइन dir को `~/.agents/plugins/failproofai/` पर ड्रॉप करता है और Goose इसे स्वचालित रूप से खोजता है। ब्लॉकिंग `PreToolUse` event पर `{"decision":"block"}` JSON है (जो shell टूल के लिए और प्रतिनिधिमंडल किए गए सबएजेंट्स के अंदर फायर करता है), goose v1.43.0 के विरुद्ध लाइव सत्यापित; Goose के पास कोई turn-end `Stop` event नहीं है, इसलिए `require-*-before-stop` बिल्ट-इन्स लागू नहीं होते (Hermes की तरह)।

---

## इंस्टॉल करें

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएं और पहली-बार के संकेत को स्वीकार करें
failproofai
```

30 बिल्ट-इन नीतियां तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर। `FAILPROOFAI_NO_FIRST_RUN=1` के साथ पहली-बार के संकेत को अक्षम करें।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `block-push-master` | `main` / `master` को सीधे पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट, मर्ज, रीबेस |
| `block-rm-rf` | रिकर्सिव फाइल हटाना |
| `sanitize-api-keys` | एजेंट context में API कुंजियों का लीक होना |

→ [सभी 30 बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies)

---

## आपकी अपनी नीतियां

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड हो जाती है, कोई फ्लैग की आवश्यकता नहीं।
इसे कमिट करें और पूरी टीम को अगली pull पर यह मिल जाएगा।

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Writes to production paths are blocked.");
    return allow();
  },
});
```

हर नीति के लिए तीन निर्णय उपलब्ध हैं:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | ऑपरेशन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे अनुमति दें, लेकिन एजेंट के अगले प्रॉम्प्ट में context जोड़ें |

→ [कस्टम नीतियां गाइड](https://docs.befailproof.ai/custom-policies)

---

## सेशन दृश्यमानता

आपके एजेंट द्वारा किया गया हर टूल कॉल स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चला,
क्या ब्लॉक किया गया, और नीति ने एजेंट को क्या बताया — इसलिए आप अनुमान नहीं लगा रहे हैं
जब कुछ गलत हो जाता है। → [डैशबोर्ड गाइड](https://docs.befailproof.ai/dashboard)

---

## दस्तावेज़

| | |
|---|---|
| [आरंभ करें](https://docs.befailproof.ai/getting-started) | इंस्टॉलेशन और पहले कदम |
| [बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies) | सभी 30 नीतियां पैरामीटर के साथ |
| [कस्टम नीतियां](https://docs.befailproof.ai/custom-policies) | अपनी खुद की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/configuration) | कॉन्फ़िग स्कोप और मर्ज नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/dashboard) | सेशन मॉनिटर और नीति गतिविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/architecture) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए मुफ्त; failproofai की वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौता आवश्यक है। पूरे पाठ के लिए [LICENSE](./LICENSE) देखें।

---

## योगदान करना

[CONTRIBUTING.md](./CONTRIBUTING.md) देखें। नई नीतियां, edge cases, और अनुवाद सभी स्वागत हैं।

> **शुरू करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रेपो
> failproofai की अपनी हुक्स को अपने आप पर चलाता है, और वे `failproofai` import को संकलित
> `dist/` bundle के विरुद्ध हल करते हैं — बिल्ड के बिना आप `Cannot find package 'failproofai'`
> हुक त्रुटियों से टकराएंगे। `src/` बदलने के बाद पुनर्निर्माण करें। 
> [in-repo dev हुक्स काम करने से पहले बिल्ड करें](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

[Nivedit Jain](https://github.com/NiveditJain) और [Nikita Agarwal](https://github.com/nk-ag) द्वारा निर्मित।
[befailproof.ai](https://befailproof.ai)
