> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily?language=TypeScript" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>
<a href="https://trendshift.io/repositories/69722?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-69722" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/69722/daily" alt="FailproofAI%2Ffailproofai | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Ffailproofai-FF4500?style=flat-square&logo=reddit)](https://www.reddit.com/r/failproofai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**अनुवाद:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**आपके एजेंट्स के प्रत्येक harness के लिए प्रेक्षण और प्रवर्तन।**
आपके एजेंट्स जहाँ कहीं भी चलते हैं, हम उसे देखते हैं — और हम इनकार कर सकते हैं। Failproof 12 एजेंट
harnesses को हुक करता है — कोडिंग CLIs जैसे Claude Code और Codex, चैट गेटवे जैसे Hermes,
स्व-होस्ट किए गए सहायक जैसे OpenClaw — प्रत्येक रन को कैप्चर करता है और खतरनाक
टूल कॉल को निष्पादन से पहले ब्लॉक करता है। 40 अंतर्निर्मित नीतियां। शून्य विलंबता। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित हार्नेसेस

दो क्लासों में बारह हार्नेसेस — दस कोडिंग CLIs, और दो चैट और सहायक
गेटवे (Hermes, OpenClaw)। सभी में एक नीति API और एक सेशन इतिहास।
क्या कोई नीति *ब्लॉक* कर सकती है, यह प्रति-हार्नेस के आधार पर है: किसी टूल कॉल को चलाने से पहले रोकना
सभी बारह पर सत्यापित है, आठ पर बारी-अंत गेट्स। 
[प्रति-हार्नेस मैट्रिक्स](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
प्रत्येक द्वारा सम्मानित की गई घटनाओं को सूचीबद्ध करता है।

एजेंट्स जो उनमें से किसी में भी नहीं चलते हैं [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं,
जो आपको ट्रेसिंग, सेशन और ऑडिट देता है। वहां प्रवर्तन को आपके अपने रनटाइम में एक हुक की आवश्यकता है — [हमसे संपर्क करें](mailto:support@befailproof.ai) और हम इसे मैप करेंगे।

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
failproofai config                             # अपने एजेंट्स और डेमॉन को कनेक्ट करें
failproofai policies add FailproofAI/policies  # प्रवर्तन के लिए क्या चुनें
failproofai                                    # localhost:8020 पर डैशबोर्ड
```

सेटअप हुक्स को वायर करता है और **कोई नहीं** नीतियों को चुनता है — वह दूसरा कमांड है जो
मशीन पर गार्डरेल्स लगाता है, और किसी भी पैक को उसी तरह टाइप किया जाता है
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` पहले एक को पढ़ता है)। 
`failproofai config` को कोई टर्मिनल के बिना चलाएं — CI, एक कंटेनर, एक एजेंट इसे ड्राइव कर रहा है — और यह पूछने के बजाय लागू होता है। 
एक मशीन पर जो कभी सेटअप नहीं की गई है, कोई भी अन्य कमांड पहले उसी विज़ार्ड को चलाता है; `FAILPROOFAI_NO_FIRST_RUN=1` के साथ उसे अक्षम करें।

जब तक कोई पैक न आए, एकमात्र चीज़ जो प्रवर्तन करती है वह है `block-failproofai-commands`,
जो हमेशा चालू है और इसे बंद या रोका नहीं जा सकता: एक एजेंट जो प्रवर्तन को रोक सकता है
हर दूसरी नीति को बंद कर सकता है।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `block-env-files` | `.env` और अन्य गुप्त फाइलों को पढ़ना |
| `warn-repeated-tool-calls` | एजेंट एक ही कॉल पर लूप करना |
| `block-sudo` | विशेषाधिकार वृद्धि |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, असीमित `DELETE` |
| `block-terraform` / `block-kubectl` | लाइव बुनियादी ढांचे में अनुमोदित परिवर्तन |
| `block-rm-rf` | पुनरावर्ती फाइल हटाना |
| `block-force-push` / `block-push-master` | `git push --force`, `main` को सीधे पुश |

ये सभी कॉल को चलाने से पहले गेट करते हैं, इसलिए वे सभी बारह हार्नेसेस पर काम करते हैं। 
पहले चार किसी भी एजेंट पर लागू होते हैं जो एक टूल कॉल कर सकता है; अंतिम
तीन डेवलपर पसंद हैं — कोडिंग CLIs harness क्लास है जिसे हम सबसे गहराई से कवर करते हैं। 
`sanitize-*` परिवार अलग है: यह एक टूल के बाद चलता है, इसलिए
यह संदर्भ से इसे बाहर रखने के बजाय टूल आउटपुट में एक गुप्त की रिपोर्ट करता है।

→ [सभी 40 अंतर्निर्मित नीतियां](https://docs.befailproof.ai/policies/packs)

---

## आपकी अपनी नीतियां

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड हो जाती है, कोई झंडे की आवश्यकता नहीं है।
इसे कमिट करें और पूरी टीम को अगली pull पर मिलता है।

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
| `instruct(message)` | इसे चलाने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [एक नीति लिखें](https://docs.befailproof.ai/policies/editor)

---

## प्रेक्षण

प्रवर्तन एक आधा है। दूसरा आधा देखना है कि एजेंट ने वास्तव में क्या किया।

कोई तर्क के बिना `failproofai` चलाएं और यह `localhost:8020` पर एक डैशबोर्ड परोसता है
आपकी मशीन पर पहले से मौजूद रन इतिहास को पढ़ता है — कोई खाता नहीं, कोई साइन अप नहीं, कुछ भी
बॉक्स से बाहर नहीं जा रहा। आपको सेशन सूची, मॉडल कॉल, टूल कॉल की अनुक्रमिकता मिलती है
और प्रत्येक रन के अंदर हुक निर्णय, क्या ब्लॉक किया गया और नीति ने एजेंट को क्या बताया,
और एक ऑफलाइन ऑडिट (`failproofai audit`) जो जोखिम भरे पैटर्न के लिए आपके इतिहास को स्कैन करता है
और उन्हें रोकने के लिए नीतियों का सुझाव देता है।

→ [स्थानीय डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[स्थानीय ऑडिट](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI प्रेक्षण** एक फ्लीट में एजेंट्स चलाने वाली टीमों के लिए एक ही डेटा मॉडल का होस्ट किया गया पक्ष है:
एक जगह में प्रत्येक हार्नेस से प्रत्येक रन, समानांतर उप-एजेंट्स के साथ एक निष्पादन ग्राफ
उनकी अपनी लेन पर, मॉडल, टूल्स और हुक्स के लिए p50/p95/p99 विलंबता, प्रति-मॉडल लागत और संदर्भ-विंडो ट्रैकिंग,
त्रुटि ट्रैकिंग, अपने स्वयं के ट्रेसेस पर SQL साझा करने योग्य डैशबोर्ड के साथ,
आपकी अपनी सेवा द्वारा स्कोर किए गए मूल्यांकन, अनुसूचित ऑडिट जो आवर्ती विफलताओं को साक्ष्य-समर्थित निष्कर्षों में बदलते हैं,
और Slack, ईमेल या एक हस्ताक्षरित webhook को भेजे गए अलर्ट। 
आपके स्वयं के क्लस्टर में स्व-होस्टिंग Enterprise plan पर उपलब्ध है।

→ [सेशन](https://docs.befailproof.ai/sessions/overview) ·
[ऑडिट](https://docs.befailproof.ai/audits/overview) ·
[डेमो बुक करें](https://befailproof.ai/get-a-demo)

---

## दस्तावेज़

| शुरू करें | |
|---|---|
| [त्वरित शुरुआत](https://docs.befailproof.ai/start/quickstart) | इंस्टॉल करें, एक हार्नेस कनेक्ट करें, पहला रन देखें |
| [अवधारणाएं](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |
| [समर्थित हार्नेसेस](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और प्रत्येक क्या प्रवर्तन कर सकता है |

| देखें | |
|---|---|
| [सेशन](https://docs.befailproof.ai/sessions/overview) | एक रन का पालन करें: मॉडल, टूल्स, त्रुटियां, विलंबता |
| [एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | निष्पादन ग्राफ आपको क्या बता रहा है |
| [ऑडिट](https://docs.befailproof.ai/audits/overview) | कई सेशन में विफलता पैटर्न खोजें |
| [स्थानीय डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई खाता आवश्यक नहीं |

| प्रवर्तन करें | |
|---|---|
| [नीति पैक](https://docs.befailproof.ai/policies/packs) | Failproof AI नीतियां, और नीति हब से पैक |
| [एक नीति लिखें](https://docs.befailproof.ai/policies/editor) | एक ऑडिट से, या कोड में |
| [विन्यास](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फिग स्कोप, मर्ज नियम और नीति पैरामीटर |

| अपना एजेंट साधन | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | कोई harness के बिना एक एजेंट से रन की रिपोर्ट करें |
| [नीति SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` संदर्भ |

---

## लाइसेंस

[Commons Clause](https://commonsclause.com/) के साथ MIT — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai के वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौता आवश्यक है। पूरी पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई नीतियां, edge cases, और अनुवाद सभी का स्वागत है।

> **शुरू करने से पहले बनाएं।** पहले `bun install && bun run build` चलाएं। यह रिपो failproofai की अपनी हुक्स को
> स्वयं पर चलाता है, और वे संकलित `dist/` बंडल के विरुद्ध `failproofai` import को हल करते हैं —
> एक बिल्ड के बिना आपको `Cannot find package 'failproofai'` हुक त्रुटियां मिलेंगी।
> `src/` को बदलने के बाद फिर से बनाएं। 
> [इन-रिपो dev हुक्स काम करने के लिए बिल्ड करें](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

❤️ के साथ [befailproof.ai](https://befailproof.ai) द्वारा SF और बेंगलुरु में निर्मित।
