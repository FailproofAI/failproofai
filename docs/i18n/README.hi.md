> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs-old/i18n/README.zh.md) · [日本語](../../docs-old/i18n/README.ja.md) · [한국어](../../docs-old/i18n/README.ko.md) · [Español](../../docs-old/i18n/README.es.md) · [Português](../../docs-old/i18n/README.pt-br.md) · [Deutsch](../../docs-old/i18n/README.de.md) · [Français](../../docs-old/i18n/README.fr.md) · [Руссий](../../docs-old/i18n/README.ru.md) · [हिन्दी](../../docs-old/i18n/README.hi.md) · [Türkçe](../../docs-old/i18n/README.tr.md) · [Tiếng Việt](../../docs-old/i18n/README.vi.md) · [Italiano](../../docs-old/i18n/README.it.md) · [العربية](../../docs-old/i18n/README.ar.md) · [עברית](../../docs-old/i18n/README.he.md)

**कोडिंग एजेंट्स के लिए रनटाइम फेलियर रेजोल्यूशन।**
Claude Code और Codex में हुक करता है। लूप्स, खतरनाक कार्यों, और सीक्रेट लीक्स को घटना बनने से पहले पकड़ता है। जीरो लेटेंसी। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
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
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openai-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/copilot-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/cursor-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/opencode-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/pi-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/hermes-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/factory-dark.png" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/goose-dark.svg" />
          <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

## इंस्टॉल करें

```sh
npm install -g failproofai
failproofai policies --install   # या सिर्फ `failproofai` चलाएं और पहली बार के प्रॉम्प्ट को स्वीकार करें
failproofai
```

30 बिल्ट-इन पॉलिसीज तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर उपलब्ध है। पहली बार के प्रॉम्प्ट को `FAILPROOFAI_NO_FIRST_RUN=1` से अक्षम करें।

---

## यह क्या रोकता है

| पॉलिसी | क्या ब्लॉक करता है |
|---|---|
| `block-push-master` | `main` / `master` को सीधे पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट, मर्ज, रीबेस |
| `block-rm-rf` | रिकर्सिव फाइल डिलीशन |
| `sanitize-api-keys` | एजेंट कॉन्टेक्स्ट में API कीज़ लीक होना |

→ [सभी 30 बिल्ट-इन पॉलिसीज](https://docs.befailproof.ai/policies/builtin)

---

## अपनी खुद की पॉलिसीज

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड होती है, कोई फ्लैग की जरूरत नहीं है।
इसे कमिट करें और पूरी टीम को अगले पुल पर मिलेगी।

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

हर पॉलिसी के लिए तीन निर्णय उपलब्ध हैं:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | ऑपरेशन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे आगे बढ़ने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में कॉन्टेक्स्ट जोड़ें |

→ [कस्टम पॉलिसीज गाइड](https://docs.befailproof.ai/policies/custom)

---

## सेशन दृश्यमानता

आपके एजेंट द्वारा किए गए हर टूल कॉल को स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चला,
क्या ब्लॉक किया गया, और पॉलिसी ने एजेंट को क्या बताया — तो आप अनुमान नहीं लगा रहे हैं
जब कुछ गलत होता है। → [डैशबोर्ड गाइड](https://docs.befailproof.ai/sessions/overview)

---

## डॉक्यूमेंटेशन

| | |
|---|---|
| [शुरू करना](https://docs.befailproof.ai/start/quickstart) | इंस्टॉलेशन और पहले कदम |
| [बिल्ट-इन पॉलिसीज](https://docs.befailproof.ai/policies/builtin) | सभी 30 पॉलिसीज पैरामीटर के साथ |
| [कस्टम पॉलिसीज](https://docs.befailproof.ai/policies/custom) | अपनी खुद की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फ़िग स्कोप्स और मर्ज नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/sessions/overview) | सेशन मॉनिटर और पॉलिसी कार्यविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai के वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान देना

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई पॉलिसीज, एज केसेस, और अनुवाद सभी स्वागत हैं।

> **शुरू करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रेपो failproofai की अपनी हुक्स को अपने आप पर चलाता है, और वे `failproofai` इंपोर्ट को कंपाइल किए गए `dist/` बंडल के विरुद्ध हल करते हैं — बिल्ड के बिना आप `Cannot find package 'failproofai'` हुक त्रुटियों में आएंगे। `src/` बदलने के बाद फिर से बिल्ड करें। देखें [बिल्ड करें रिपो में dev हुक्स के काम करने से पहले](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)।

---

SF और बेंगलुरु में [befailproof.ai](https://befailproof.ai) द्वारा ❤️ से बनाया गया।
