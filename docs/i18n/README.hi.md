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

**आपके एजेंट्स द्वारा चलाए जाने वाले हर हार्नेस के लिए अवलोकन और प्रवर्तन।**
जहाँ भी आपके एजेंट्स चलते हैं, हम उन्हें देख सकते हैं — और हम मना कर सकते हैं। Failproof 12 एजेंट
हार्नेस को हुक करता है — Claude Code और Codex जैसे कोडिंग CLIs, Hermes जैसे चैट गेटवे,
OpenClaw जैसे स्वयं-होस्ट किए गए असिस्टेंट्स — हर रन को कैप्चर करता है और निष्पादन से पहले
खतरनाक टूल कॉल्स को ब्लॉक करता है। 40 बिल्ट-इन पॉलिसीज। शून्य लेटेंसी। स्थानीय रूप से चलता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित हार्नेस

दो वर्गों में बारह हार्नेस — दस कोडिंग CLIs, और दो चैट और असिस्टेंट
गेटवे (Hermes, OpenClaw)। सभी के लिए एक पॉलिसी API और एक सेशन हिस्ट्री।
एक पॉलिसी क्या *ब्लॉक* कर सकती है यह प्रति-हार्नेस है: एक टूल कॉल को चलाने से पहले
रोकना सभी बारह पर सत्यापित है, टर्न-एंड गेट्स आठ पर हैं। 
[प्रति-हार्नेस मैट्रिक्स](https://docs.befailproof.ai/reference/harnesses#enforcement-capability)
प्रत्येक का सम्मान करने वाली घटनाओं को सूचीबद्ध करता है।

जो एजेंट्स इनमें से किसी में नहीं चलते वे [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं,
जो आपको ट्रेसिंग, सेशन और ऑडिट देता है। वहाँ प्रवर्तन के लिए
आपके अपने रनटाइम में एक हुक की आवश्यकता है — [हमसे संपर्क करें](mailto:support@befailproof.ai) और हम इसे मैप करेंगे।

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
failproofai config                             # अपने एजेंट्स और डेमन को वायर करें
failproofai policies add FailproofAI/policies  # प्रवर्तित करने के लिए चुनें
failproofai                                    # localhost:8020 पर डैशबोर्ड
```

सेटअप हुक्स को वायर करता है और **कोई नहीं** पॉलिसीज चुनता है — दूसरा कमांड वह है जो
मशीन पर गार्डरेल्स लगाता है, और कोई भी पैक वही तरीके से टाइप किया जाता है
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` पहले एक पढ़ता है)। 
`failproofai config` को टर्मिनल के बिना चलाएं — CI, एक कंटेनर, एक
एजेंट इसे ड्राइव कर रहा है — और यह पूछने के बजाय लागू होता है। एक मशीन पर जो कभी
सेटअप नहीं हुई है, कोई भी अन्य कमांड पहले समान विज़ार्ड चलाता है; `FAILPROOFAI_NO_FIRST_RUN=1` के साथ इसे अक्षम करें।

जब तक एक पैक न आए, एकमात्र चीज़ जो प्रवर्तित करती है वह `block-failproofai-commands` है,
जो हमेशा चालू है और इसे बंद या रोका नहीं जा सकता: एक एजेंट जो प्रवर्तन को रोक सकता है
हर दूसरी पॉलिसी को बंद कर सकता है।

---

## यह क्या रोकता है

| पॉलिसी | यह क्या ब्लॉक करता है |
|---|---|
| `block-env-files` | `.env` और अन्य गोपनीय फाइलों को पढ़ना |
| `warn-repeated-tool-calls` | एजेंट एक ही कॉल पर लूप कर रहा है |
| `block-sudo` | विशेषाधिकार एस्केलेशन |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, असीमित `DELETE` |
| `block-terraform` / `block-kubectl` | लाइव इन्फ्रास्ट्रक्चर में अनुमोदित परिवर्तन |
| `block-rm-rf` | पुनरावर्ती फाइल हटाना |
| `block-force-push` / `block-push-master` | `git push --force`, `main` पर सीधे पुश |

इनमें से प्रत्येक कॉल को *इससे पहले* चलाता है कि वह चले, इसलिए वे सभी बारह
हार्नेस पर होल्ड करते हैं। पहले चार किसी भी एजेंट पर लागू होते हैं जो एक टूल कॉल कर सकता है; 
अंतिम तीन डेवलपर पसंदीदा हैं — कोडिंग CLIs वह हार्नेस वर्ग है जो हम सबसे गहराई से कवर करते हैं। 
`sanitize-*` परिवार अलग है: यह एक टूल रिटर्न के बाद चलता है, इसलिए
यह संदर्भ में इसे रखने के बजाय टूल आउटपुट में एक गोपनीयता की रिपोर्ट करता है।

→ [सभी 40 बिल्ट-इन पॉलिसीज](https://docs.befailproof.ai/policies/packs)

---

## आपकी अपनी पॉलिसीज

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड होती है, कोई फ्लैग की आवश्यकता नहीं।
इसे कमिट करें और पूरी टीम को अगले पुल पर मिलेगा।

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
| `instruct(message)` | इसे चलने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [एक पॉलिसी लिखें](https://docs.befailproof.ai/policies/editor)

---

## अवलोकन

प्रवर्तन आधा है। दूसरा आधा यह देखना है कि एजेंट ने वास्तव में क्या किया।

`failproofai` को बिना तर्क के चलाएं और यह आपकी मशीन पर पहले से मौजूद रन हिस्ट्री
को पढ़ते हुए `localhost:8020` पर एक डैशबोर्ड परोसता है — कोई खाता नहीं, कोई साइन अप नहीं, 
कुछ भी बॉक्स से बाहर नहीं जा रहा है। आप सेशन सूची, प्रत्येक रन के अंदर मॉडल कॉल्स, 
टूल कॉल्स और हुक निर्णयों का क्रम, क्या ब्लॉक किया गया और पॉलिसी ने एजेंट को क्या बताया, 
और एक ऑफलाइन ऑडिट (`failproofai audit`) जो आपकी हिस्ट्री को जोखिम भरे पैटर्न के लिए 
स्कैन करता है और पॉलिसीज का सुझाव देता है।

→ [स्थानीय डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[स्थानीय ऑडिट](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI अवलोकन** एक फ्लीट में एजेंट्स चलाने वाली टीमों के लिए एक ही डेटा मॉडल का होस्ट किया गया पक्ष है: 
हर हार्नेस से हर रन एक जगह में, समानांतर सब-एजेंट्स के साथ एक निष्पादन ग्राफ अपनी लेन पर, 
मॉडल, टूल्स और हुक्स के लिए p50/p95/p99 लेटेंसी, प्रति-मॉडल लागत और संदर्भ-विंडो ट्रैकिंग, 
त्रुटि ट्रैकिंग, आपके अपने ट्रेसेस पर SQL साझा करने योग्य डैशबोर्ड के साथ, 
आपकी अपनी सेवा द्वारा स्कोर किए गए मूल्यांकन, अनुसूचित ऑडिट जो आवर्ती विफलताओं को 
साक्ष्य-समर्थित निष्कर्षों में बदलते हैं, और Slack, ईमेल या एक हस्ताक्षरित वेबहुक में 
रूट किए गए अलर्ट। आपके अपने क्लस्टर में स्वयं-होस्टिंग Enterprise प्लान पर उपलब्ध है।

→ [सेशन](https://docs.befailproof.ai/sessions/overview) ·
[ऑडिट](https://docs.befailproof.ai/audits/overview) ·
[डेमो बुक करें](https://befailproof.ai/get-a-demo)

---

## दस्तावेज़

| शुरुआत करें | |
|---|---|
| [क्विकस्टार्ट](https://docs.befailproof.ai/start/quickstart) | इंस्टॉल करें, एक हार्नेस कनेक्ट करें, पहला रन देखें |
| [अवधारणाएं](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |
| [समर्थित हार्नेस](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और प्रत्येक क्या प्रवर्तित कर सकता है |

| अवलोकन करें | |
|---|---|
| [सेशन](https://docs.befailproof.ai/sessions/overview) | एक रन का पालन करें: मॉडल, टूल्स, त्रुटियां, लेटेंसी |
| [एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | निष्पादन ग्राफ आपको क्या बता रहा है |
| [ऑडिट](https://docs.befailproof.ai/audits/overview) | कई सेशन में विफलता पैटर्न खोजें |
| [स्थानीय डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई खाता आवश्यक नहीं |

| प्रवर्तन करें | |
|---|---|
| [पॉलिसी पैक](https://docs.befailproof.ai/policies/packs) | Failproof AI पॉलिसीज, और पॉलिसी हब से पैक |
| [एक पॉलिसी लिखें](https://docs.befailproof.ai/policies/editor) | एक ऑडिट से, या कोड में |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फ़िग स्कोप, मर्ज नियम और पॉलिसी पैरामीटर |

| अपने स्वयं के एजेंट को इंस्ट्रूमेंट करें | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | कोई हार्नेस नहीं होने वाले एजेंट से रन रिपोर्ट करें |
| [पॉलिसी SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` संदर्भ |

---

## लाइसेंस

[Commons Clause](https://commonsclause.com/) के साथ MIT — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai की वाणिज्यिक पुनर्विक्रय के लिए अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान देना

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई पॉलिसीज, किनारे के मामले, और अनुवाद सभी स्वागत हैं।

---

SF और बेंगलुरु में [befailproof.ai](https://befailproof.ai) द्वारा ❤️ के साथ निर्मित।
