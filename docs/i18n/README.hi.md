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
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**आपके एजेंट्स द्वारा चलाए जाने वाले हर हार्नेस के लिए अवलोकन और प्रवर्तन।**
जहाँ भी आपके एजेंट्स चलते हैं, हम उन्हें देखते हैं — और हम ना कह सकते हैं। Failproof 12 एजेंट हार्नेस को हुक करता है — कोडिंग CLIs जैसे Claude Code और Codex, चैट गेटवे जैसे Hermes, सेल्फ-होस्टेड असिस्टेंट्स जैसे OpenClaw — हर चलाव को कैप्चर करता है और खतरनाक टूल कॉल्स को निष्पादन से पहले ब्लॉक करता है। 39 बिल्ट-इन पॉलिसीज़। शून्य लेटेंसी। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित हार्नेस

दो वर्गों में बारह हार्नेस — दस कोडिंग CLIs, और दो चैट और असिस्टेंट गेटवे (Hermes, OpenClaw)। समान इवेंट्स, समान पॉलिसीज़, समान सेशन हिस्ट्री, भले ही आपका एजेंट किसी में भी चले।

जो एजेंट्स इनमें से किसी में भी नहीं चलते, वे [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं, जो आपको ट्रेसिंग, सेशन्स और ऑडिट्स देता है। वहाँ प्रवर्तन के लिए आपके स्वयं के रनटाइम में एक हुक की आवश्यकता है — [हमसे बात करें](mailto:support@befailproof.ai) और हम इसे मैप करेंगे।

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
failproofai policies --install   # या बस `failproofai` चलाएं और पहली बार के प्रॉम्प्ट को स्वीकार करें
failproofai
```

39 बिल्ट-इन पॉलिसीज़ तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर। पहली बार के प्रॉम्प्ट को `FAILPROOFAI_NO_FIRST_RUN=1` के साथ अक्षम करें।

---

## यह क्या रोकता है

| पॉलिसी | यह क्या ब्लॉक करता है |
|---|---|
| `sanitize-api-keys` | एजेंट के कॉन्टेक्स्ट में एपीआई कीज़ का लीक होना |
| `block-env-files` | `.env` और अन्य गुप्त फ़ाइलों को पढ़ना |
| `warn-repeated-tool-calls` | एजेंट का एक ही कॉल पर लूप करना |
| `block-sudo` | प्रिविलेज एस्केलेशन |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, अनबाउंडेड `DELETE` |
| `block-terraform` / `block-kubectl` | लाइव इंफ्रास्ट्रक्चर में अनरिव्यूड परिवर्तन |
| `block-rm-rf` | रिकर्सिव फ़ाइल डिलीशन |
| `block-force-push` / `block-push-master` | `git push --force`, `main` को सीधे पुश |

पहली पाँच किसी भी एजेंट पर लागू होती हैं जो टूल कॉल कर सकता है। अंतिम तीन डेवलपर के पसंदीदा हैं — कोडिंग CLIs वह हार्नेस क्लास है जिसे हम सबसे गहराई से कवर करते हैं।

→ [सभी 39 बिल्ट-इन पॉलिसीज़](https://docs.befailproof.ai/policies/builtin)

---

## आपकी अपनी पॉलिसीज़

`.failproofai/policies/` में एक फ़ाइल ड्रॉप करें — यह स्वचालित रूप से लोड होती है, कोई फ्लैग की आवश्यकता नहीं है। इसे कमिट करें और पूरी टीम को अगले पुल पर यह मिलेगा।

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
| `allow()` | ऑपरेशन को अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे अनुमति दें, लेकिन एजेंट के अगले प्रॉम्प्ट में कॉन्टेक्स्ट जोड़ें |

→ [कस्टम पॉलिसीज़ गाइड](https://docs.befailproof.ai/policies/custom)

---

## अवलोकन

प्रवर्तन एक आधा है। दूसरा आधा यह देखना है कि एजेंट ने वास्तव में क्या किया।

बिना किसी तर्क के `failproofai` चलाएं और यह `localhost:8020` पर एक डैशबोर्ड परोसता है जो आपकी मशीन पर पहले से मौजूद रन हिस्ट्री को पढ़ता है — कोई अकाउंट, कोई साइनअप, कुछ भी बॉक्स से बाहर नहीं जाता। आप सेशन लिस्ट, हर रन के अंदर मॉडल कॉल्स, टूल कॉल्स और हुक डिसिजन्स का अनुक्रम, क्या ब्लॉक किया गया और पॉलिसी ने एजेंट को क्या बताया, और एक ऑफलाइन ऑडिट (`failproofai audit`) देखते हैं जो आपकी हिस्ट्री को जोखिम भरे पैटर्न के लिए स्कैन करता है और पॉलिसीज़ सुझाता है उन्हें रोकने के लिए।

→ [लोकल डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) · [ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) · [लोकल ऑडिट](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI अवलोकन** एक ही डेटा मॉडल का होस्टेड हिस्सा है, एजेंट्स को एक फ्लीट में चलाने वाली टीमों के लिए: हर हार्नेस से हर रन एक जगह में, समानांतर सब-एजेंट्स के साथ एक निष्पादन ग्राफ उनकी अपनी लेन में, मॉडल्स, टूल्स और हुक्स के लिए p50/p95/p99 लेटेंसी, प्रति-मॉडल लागत और कॉन्टेक्स्ट-विंडो ट्रैकिंग, एरर ट्रैकिंग, आपके स्वयं के ट्रेस्स पर SQL शेयरेबल डैशबोर्ड के साथ, आपकी स्वयं की सेवा द्वारा स्कोर किए गए इवैल्यूएशन्स, शेड्यूल किए गए ऑडिट्स जो आवर्ती विफलताओं को साक्ष्य-समर्थित निष्कर्षों में बदलते हैं, और Slack, ईमेल या एक हस्ताक्षरित वेबहुक को रूट किए गए अलर्ट। आपके अपने क्लस्टर में सेल्फ-होस्टिंग एंटरप्राइज प्लान पर उपलब्ध है।

→ [सेशन्स](https://docs.befailproof.ai/sessions/overview) · [ऑडिट्स](https://docs.befailproof.ai/audits/overview) · [डेमो बुक करें](https://befailproof.ai/get-a-demo)

---

## प्रलेखन

| शुरुआत करें | |
|---|---|
| [क्विकस्टार्ट](https://docs.befailproof.ai/start/quickstart) | इंस्टॉल करें, एक हार्नेस कनेक्ट करें, पहला रन देखें |
| [अवधारणाएं](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |
| [समर्थित हार्नेस](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और हर एक क्या प्रवर्तन कर सकता है |

| अवलोकन करें | |
|---|---|
| [सेशन्स](https://docs.befailproof.ai/sessions/overview) | एक रन को फॉलो करें: मॉडल्स, टूल्स, एरर्स, लेटेंसी |
| [ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | निष्पादन ग्राफ आपको क्या बता रहा है |
| [ऑडिट्स](https://docs.befailproof.ai/audits/overview) | कई सेशन्स में विफलता पैटर्न खोजें |
| [लोकल डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई अकाउंट की आवश्यकता नहीं |

| प्रवर्तन करें | |
|---|---|
| [बिल्ट-इन पॉलिसीज़](https://docs.befailproof.ai/policies/builtin) | सभी 39 पॉलिसीज़ पैरामीटर्स के साथ |
| [कस्टम पॉलिसीज़](https://docs.befailproof.ai/policies/custom) | अपनी अपनी पॉलिसीज़ लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फ़िग स्कोप्स और मर्ज नियम |

| अपने स्वयं के एजेंट को इंस्ट्रूमेंट करें | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | कोई हार्नेस न होने वाले एजेंट से रन रिपोर्ट करें |
| [पॉलिसी SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` संदर्भ |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai स्वयं के वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान देना

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई पॉलिसीज़, एज केसेस, और अनुवाद सभी स्वागत हैं।

> **शुरुआत करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रेपो failproofai की अपनी हुक्स को स्वयं पर चलाता है, और वे कंपाइल किए गए `dist/` बंडल के विरुद्ध `failproofai` आयात को हल करते हैं — बिल्ड के बिना आप `Cannot find package 'failproofai'` हुक एरर्स से टकराएंगे। `src/` बदलने के बाद रीबिल्ड करें। [इन-रेपो डेव हुक्स काम करने के लिए पहले बिल्ड करें](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

SF और बेंगलुरु में [befailproof.ai](https://befailproof.ai) द्वारा ❤️ के साथ बनाया गया।
