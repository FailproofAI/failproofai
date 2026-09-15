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

**प्रत्येक हार्नेस के लिए अवलोकनीयता और प्रवर्तन जहां आपके एजेंट चलते हैं।**
आपके एजेंट जहां भी चलें, हम इसे देखते हैं — और हम नहीं कह सकते। Failproof 12 एजेंट
हार्नेस को हुक करता है — कोडिंग CLIs जैसे Claude Code और Codex, चैट गेटवे जैसे Hermes,
स्व-होस्ट किए गए सहायक जैसे OpenClaw — प्रत्येक रन को कैप्चर करना और खतरनाक
टूल कॉल को निष्पादन से पहले ब्लॉक करना। 39 बिल्ट-इन नीतियाँ। शून्य लेटेंसी। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित हार्नेस

दो वर्गों में बारह हार्नेस — दस कोडिंग CLIs, और दो चैट और सहायक
गेटवे (Hermes, OpenClaw)। समान ईवेंट, समान नीतियाँ, समान सत्र इतिहास,
चाहे आपका एजेंट किसमें भी चले।

जो एजेंट इनमें से किसी में भी नहीं चलते हैं वे [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं,
जो आपको ट्रेसिंग, सत्र और ऑडिट देता है। वहाँ प्रवर्तन के लिए आपके अपने रनटाइम में एक हुक की आवश्यकता होती है — [हमसे बात करें](mailto:support@befailproof.ai) और हम इसे मैप करेंगे।

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
failproofai policies --install   # या बस `failproofai` चलाएं और पहली बार के संकेत को स्वीकार करें
failproofai
```

39 बिल्ट-इन नीतियाँ तुरंत सक्रिय हो जाती हैं। डैशबोर्ड `localhost:8020` पर। पहली बार के संकेत को `FAILPROOFAI_NO_FIRST_RUN=1` से अक्षम करें।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `sanitize-api-keys` | API कुंजियाँ एजेंट के संदर्भ में लीक होना |
| `block-env-files` | `.env` और अन्य गुप्त फाइलों का पढ़ना |
| `warn-repeated-tool-calls` | एजेंट एक ही कॉल पर लूपिंग करना |
| `block-sudo` | विशेषाधिकार एस्केलेशन |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, असीमित `DELETE` |
| `block-terraform` / `block-kubectl` | लाइव बुनियादी ढाँचे में बिना समीक्षा के परिवर्तन |
| `block-rm-rf` | पुनरावर्ती फाइल हटाना |
| `block-force-push` / `block-push-master` | `git push --force`, `main` को सीधा पुश |

पहली पाँच किसी भी एजेंट पर लागू होती हैं जो एक टूल कॉल कर सकता है। अंतिम तीन
डेवलपर पसंदीदा हैं — कोडिंग CLIs हार्नेस का वर्ग हैं जिसे हम सबसे गहराई से कवर करते हैं।

→ [सभी 39 बिल्ट-इन नीतियाँ](https://docs.befailproof.ai/policies/builtin)

---

## आपकी अपनी नीतियाँ

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड होती है, कोई फ्लैग की आवश्यकता नहीं।
इसे कमिट करें और पूरी टीम को अगली पुल पर मिल जाएगा।

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
| `instruct(message)` | इसे के माध्यम से चलने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [कस्टम नीतियाँ गाइड](https://docs.befailproof.ai/policies/custom)

---

## अवलोकनीयता

प्रवर्तन एक आधा है। दूसरा आधा यह देखना है कि एजेंट ने वास्तव में क्या किया।

बिना किसी तर्क के `failproofai` चलाएं और यह `localhost:8020` पर एक डैशबोर्ड प्रस्तुत करता है
जो आपकी मशीन पर पहले से मौजूद रन हिस्ट्री को पढ़ता है — कोई खाता, कोई साइन-अप, कुछ भी
बॉक्स से बाहर नहीं जा रहा। आप सत्र सूची, मॉडल कॉल का क्रम, टूल कॉल और हुक निर्णय
प्रत्येक रन के अंदर, क्या ब्लॉक किया गया और नीति ने एजेंट को क्या बताया, और एक ऑफ़लाइन ऑडिट (`failproofai audit`) प्राप्त करते हैं
जो आपके इतिहास को जोखिम भरे पैटर्न के लिए स्कैन करता है और नीतियों का सुझाव देता है
उन्हें रोकने के लिए।

→ [लोकल डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[स्थानीय ऑडिट](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI अवलोकनीयता** समान डेटा मॉडल का होस्ट किया गया पक्ष है, एजेंट चलाने वाली टीमों के लिए
एक बेड़े में: हर हार्नेस से हर रन एक जगह में, एक निष्पादन ग्राफ अपने स्वयं के लेन पर समानांतर
उप-एजेंट के साथ, p50/p95/p99 मॉडल, टूल और हुक के लिए लेटेंसी, प्रति-मॉडल लागत और
संदर्भ-विंडो ट्रैकिंग, त्रुटि ट्रैकिंग, आपके अपने ट्रेस पर SQL साझा करने योग्य डैशबोर्ड के साथ,
आपकी अपनी सेवा द्वारा स्कोर किए गए मूल्यांकन, निर्धारित ऑडिट जो आवर्ती विफलता को
साक्ष्य-आधारित निष्कर्ष में बदलते हैं, और Slack, ईमेल या हस्ताक्षरित वेबहुक को भेजे गए अलर्ट।
आपके अपने क्लस्टर में स्व-होस्टिंग एंटरप्राइज योजना पर उपलब्ध है।

→ [सत्र](https://docs.befailproof.ai/sessions/overview) ·
[ऑडिट](https://docs.befailproof.ai/audits/overview) ·
[डेमो बुक करें](https://befailproof.ai/get-a-demo)

---

## दस्तावेज़

| शुरुआत | |
|---|---|
| [त्वरित शुरुआत](https://docs.befailproof.ai/start/quickstart) | स्थापित करें, एक हार्नेस कनेक्ट करें, पहला रन देखें |
| [अवधारणाएँ](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |
| [समर्थित हार्नेस](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और प्रत्येक क्या प्रवर्तन कर सकता है |

| अवलोकन करें | |
|---|---|
| [सत्र](https://docs.befailproof.ai/sessions/overview) | एक रन का पालन करें: मॉडल, टूल, त्रुटियाँ, लेटेंसी |
| [एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | निष्पादन ग्राफ आपको क्या बता रहा है |
| [ऑडिट](https://docs.befailproof.ai/audits/overview) | कई सत्रों में विफलता पैटर्न खोजें |
| [स्थानीय डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई खाता आवश्यक नहीं |

| प्रवर्तन | |
|---|---|
| [बिल्ट-इन नीतियाँ](https://docs.befailproof.ai/policies/builtin) | सभी 39 नीतियाँ पैरामीटर के साथ |
| [कस्टम नीतियाँ](https://docs.befailproof.ai/policies/custom) | अपनी खुद की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फ़िग स्कोप और मर्ज नियम |

| अपने स्वयं के एजेंट को साधन | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | बिना हार्नेस वाले एजेंट से रन रिपोर्ट करें |
| [नीति SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` संदर्भ |

---

## लाइसेंस

[Commons Clause](https://commonsclause.com/) के साथ MIT — आंतरिक और व्यक्तिगत उपयोग के लिए मुफ्त; failproofai स्वयं का वाणिज्यिक पुनर्विक्रय को एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई नीतियाँ, एज केस, और अनुवाद सभी का स्वागत है।

> **शुरू करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रिपो failproofai की अपनी हुक को
> अपने ऊपर चलाता है, और वे `failproofai` आयात को संकलित `dist/` बंडल के विरुद्ध हल करते हैं — बिल्ड के बिना
> आप `Cannot find package 'failproofai'` हुक त्रुटियों को हिट करेंगे। `src/` को बदलने के बाद
> पुनः बिल्ड करें। [बिल्ड से पहले इन-रिपो डेव हुक काम करेंगे](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

SF और बेंगलुरु में [befailproof.ai](https://befailproof.ai) द्वारा ❤️ के साथ बनाया गया।
