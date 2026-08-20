> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**कोडिंग एजेंट्स के लिए रनटाइम विफलता समाधान।**
Claude Code और Codex में हुक करता है। लूप्स, खतरनाक कार्यों और गोपनीय रिसाव को
घटनाओं में बदलने से पहले पकड़ता है। शून्य विलंबता। स्थानीय रूप से चलता है।

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

## स्थापना

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएँ और पहली बार के संकेत को स्वीकार करें
failproofai
```

30 अंतर्निर्मित नीतियाँ तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर है। `FAILPROOFAI_NO_FIRST_RUN=1` के साथ पहली बार के संकेत को अक्षम करें।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `block-push-master` | `main` / `master` के लिए प्रत्यक्ष पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट्स, मर्ज, रीबेसेस |
| `block-rm-rf` | पुनरावर्ती फ़ाइल विलोपन |
| `sanitize-api-keys` | एजेंट संदर्भ में API कुंजी रिसाव |

→ [सभी 30 अंतर्निर्मित नीतियाँ](https://docs.befailproof.ai/built-in-policies)

---

## आपकी अपनी नीतियाँ

`.failproofai/policies/` में एक फ़ाइल छोड़ें — यह स्वचालित रूप से लोड होती है, कोई फ़्लैग की आवश्यकता नहीं है।
इसे कमिट करें और पूरी टीम को अगली पुल पर मिलेगी।

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

→ [कस्टम नीतियाँ गाइड](https://docs.befailproof.ai/custom-policies)

---

## सेशन दृश्यता

आपका एजेंट जो भी टूल कॉल करता है वह स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चला,
क्या ब्लॉक किया गया, और नीति ने एजेंट को क्या बताया — इसलिए आप अनुमान नहीं लगा रहे हैं
जब कुछ गलत हो जाता है। → [डैशबोर्ड गाइड](https://docs.befailproof.ai/dashboard)

---

## दस्तावेज़

| | |
|---|---|
| [शुरुआत करें](https://docs.befailproof.ai/getting-started) | स्थापना और पहले कदम |
| [अंतर्निर्मित नीतियाँ](https://docs.befailproof.ai/built-in-policies) | सभी 30 नीतियाँ पैरामीटर के साथ |
| [कस्टम नीतियाँ](https://docs.befailproof.ai/custom-policies) | अपने स्वयं के लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/configuration) | कॉन्फ़िग स्कोप और मर्ज नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/dashboard) | सेशन मॉनिटर और नीति गतिविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/architecture) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai का वाणिज्यिक पुनर्विक्रय एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई नीतियाँ, सीमांत मामले और अनुवाद सभी स्वागत हैं।

> **बिल्ड करने से पहले शुरुआत करें।** पहले `bun install && bun run build` चलाएँ। यह रिपो स्वयं पर failproofai के हुक चलाता है, और वे संकलित `dist/` बंडल के विरुद्ध `failproofai` आयात को हल करते हैं — बिल्ड के बिना आपको `Cannot find package 'failproofai'` हुक त्रुटियों मिलेंगी। `src/` को बदलने के बाद फिर से बिल्ड करें। देखें
> [इन-रिपो डेव हुक काम करने से पहले बिल्ड करें](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work)।

---

[Nivedit Jain](https://github.com/NiveditJain) और [Nikita Agarwal](https://github.com/nk-ag) द्वारा निर्मित।
[befailproof.ai](https://befailproof.ai)
