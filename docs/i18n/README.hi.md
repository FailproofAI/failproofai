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

**कोडिंग एजेंटों के लिए रनटाइम विफलता समाधान।**
Claude Code और Codex में हुक किया गया। लूप्स, खतरनाक क्रियाएं, और सीक्रेट लीक को
समस्याओं से पहले पकड़ता है। शून्य विलंबता। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित एजेंट CLIs

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://developers.openai.com/codex" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com/docs/hooks" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://opencode.ai/docs/plugins/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://geminicli.com/" title="Gemini CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/gemini-dark.svg" />
      <img src="assets/logos/gemini-light.svg" alt="Gemini CLI" width="64" height="64" />
    </picture>
  </a>
</p>

> एक या किसी भी संयोजन के लिए हुक इंस्टॉल करें: `failproofai policies --install --cli opencode pi gemini` (या `--cli claude codex copilot cursor opencode pi gemini`)। स्वचालित रूप से इंस्टॉल किए गए CLIs का पता लगाने और संकेत देने के लिए `--cli` को छोड़ दें।

---

## इंस्टॉल करें

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएं और पहली बार चलाने के संकेत को स्वीकार करें
failproofai
```

30 बिल्ट-इन नीतियां तुरंत सक्रिय होती हैं। डैशबोर्ड `localhost:8020` पर। `FAILPROOFAI_NO_FIRST_RUN=1` के साथ पहली बार चलाने के संकेत को अक्षम करें।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `block-push-master` | `main` / `master` के लिए सीधे पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट, मर्ज, रीबेस |
| `block-rm-rf` | पुनरावर्ती फ़ाइल हटाना |
| `sanitize-api-keys` | एजेंट संदर्भ में API कुंजियां लीक होना |

→ [सभी 30 बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies)

---

## आपकी अपनी नीतियां

`.failproofai/policies/` में एक फ़ाइल छोड़ें — यह स्वचालित रूप से लोड होती है, कोई फ्लैग की आवश्यकता नहीं है।
इसे कमिट करें और पूरी टीम को अगले पुल पर मिल जाएगा।

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
| `allow()` | संचालन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे जारी रखें, लेकिन एजेंट के अगले संकेत में संदर्भ जोड़ें |

→ [कस्टम नीतियां गाइड](https://docs.befailproof.ai/custom-policies)

---

## सत्र दृश्यता

आपके एजेंट द्वारा किया गया प्रत्येक टूल कॉल स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चला,
क्या ब्लॉक किया गया, और नीति ने एजेंट को क्या बताया — इसलिए जब कुछ गलत हो जाए तो आप अनुमान नहीं लगाते हैं। → [डैशबोर्ड गाइड](https://docs.befailproof.ai/dashboard)

---

## दस्तावेज़

| | |
|---|---|
| [शुरुआत करना](https://docs.befailproof.ai/getting-started) | इंस्टॉलेशन और पहले कदम |
| [बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies) | सभी 30 नीतियां पैरामीटर के साथ |
| [कस्टम नीतियां](https://docs.befailproof.ai/custom-policies) | अपनी स्वयं की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/configuration) | कॉन्फ़िगरेशन स्कोप और विलय नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/dashboard) | सत्र मॉनिटर और नीति गतिविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/architecture) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए मुक्त; failproofai के वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौते की आवश्यकता है। पूरे पाठ के लिए [LICENSE](./LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](./CONTRIBUTING.md) देखें। नई नीतियां, किनारे के मामले, और अनुवाद सभी का स्वागत है।

> **शुरू करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रिपो failproofai की स्वयं की नीतियों को स्वयं पर चलाता है, और वे `failproofai` आयात को संकलित `dist/` बंडल के विरुद्ध हल करते हैं — एक बिल्ड के बिना आप `Cannot find package 'failproofai'` हुक त्रुटियों से टकराएंगे। `src/` बदलने के बाद पुनर्निर्माण करें। [बिल्ड करें इससे पहले कि रिपो में dev हुक काम करें](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

[Nivedit Jain](https://github.com/NiveditJain) और [Nikita Agarwal](https://github.com/nk-ag) द्वारा बनाया गया।
[befailproof.ai](https://befailproof.ai)
