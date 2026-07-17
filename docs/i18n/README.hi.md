> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**अनुवाद:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**कोडिंग एजेंटों के लिए रनटाइम विफलता समाधान।**
Claude Code और Codex में हुक करता है। लूप्स, खतरनाक कार्यों, और गुप्त रिसाव को
घटना बनने से पहले ही पकड़ता है। शून्य विलंबता। स्थानीय रूप से चलता है।

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

## इंस्टॉल करें

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएं और पहली बार प्रॉम्प्ट को स्वीकार करें
failproofai
```

30 अंतर्निहित नीतियां तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर उपलब्ध है। `FAILPROOFAI_NO_FIRST_RUN=1` के साथ पहली बार की प्रॉम्प्ट को अक्षम करें।

---

## यह क्या रोकता है

| नीति | जो अवरुद्ध करता है |
|---|---|
| `block-push-master` | `main` / `master` को सीधे पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट, मर्ज, रीबेस |
| `block-rm-rf` | पुनरावर्ती फ़ाइल हटाना |
| `sanitize-api-keys` | एजेंट संदर्भ में API कुंजियों का रिसाव |

→ [सभी 30 अंतर्निहित नीतियां](https://docs.befailproof.ai/built-in-policies)

---

## आपकी अपनी नीतियां

`.failproofai/policies/` में फ़ाइल छोड़ें — यह स्वचालित रूप से लोड हो जाता है, कोई फ़्लैग की जरूरत नहीं।
इसे कमिट करें और पूरी टीम को अगले पुल पर मिलता है।

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

प्रत्येक नीति के लिए तीन निर्णय उपलब्ध हैं:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | ऑपरेशन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे आगे बढ़ने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [कस्टम नीतियां गाइड](https://docs.befailproof.ai/custom-policies)

---

## सत्र दृश्यमानता

आपके एजेंट द्वारा किए गए प्रत्येक टूल कॉल को स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चलाया गया,
क्या अवरुद्ध था, और नीति ने एजेंट को क्या बताया — इसलिए जब कुछ गलत हो तो आप अनुमान नहीं लगाते।
→ [डैशबोर्ड गाइड](https://docs.befailproof.ai/dashboard)

---

## दस्तावेज़

| | |
|---|---|
| [शुरुआत करें](https://docs.befailproof.ai/getting-started) | इंस्टॉलेशन और पहले कदम |
| [अंतर्निहित नीतियां](https://docs.befailproof.ai/built-in-policies) | सभी 30 नीतियां पैरामीटर के साथ |
| [कस्टम नीतियां](https://docs.befailproof.ai/custom-policies) | अपनी स्वयं की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/configuration) | कॉन्फ़िग स्कोप और मर्ज नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/dashboard) | सत्र मॉनिटर और नीति गतिविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/architecture) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

[Commons Clause](https://commonsclause.com/) के साथ MIT — आंतरिक और व्यक्तिगत उपयोग के लिए मुक्त; failproofai का वाणिज्यिक पुनर्विक्रय एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](./LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](./CONTRIBUTING.md) देखें। नई नीतियां, किनारे के मामले, और अनुवाद स्वागत है।

> **शुरू करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रेपो
> failproofai की अपनी हुक को स्वयं पर चलाता है, और वे `failproofai` आयात को संकलित
> `dist/` बंडल के विरुद्ध हल करते हैं — बिल्ड के बिना आपको `Cannot find package 'failproofai'`
> हुक त्रुटियां मिलेंगी। `src/` बदलने के बाद पुनर्निर्माण करें। [Build before the in-repo dev hooks will work](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

[Nivedit Jain](https://github.com/NiveditJain) और [Nikita Agarwal](https://github.com/nk-ag) द्वारा निर्मित।
[befailproof.ai](https://befailproof.ai)
