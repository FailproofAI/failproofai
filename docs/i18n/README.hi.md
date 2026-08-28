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

**देखें कि आपके एजेंट क्या करते हैं। ज्ञात विफलताओं को दोहराने से पहले रोकें।**
Failproof AI वहाँ काम करता है जहाँ आपके एजेंट चलते हैं: कोडिंग टूल जैसे Claude Code और
Codex, चैट गेटवे जैसे Hermes, स्व-होस्ट किए गए सहायक जैसे OpenClaw, और एजेंट
जिन्हें आप स्वयं उपकरण करते हैं। यह प्रत्येक रन को रिकॉर्ड करता है और खतरनाक टूल कॉल को
निष्पादन से पहले ब्लॉक कर सकता है।

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## समर्थित हार्नेस

दो वर्गों में बारह हार्नेस समर्थित हैं: दस कोडिंग CLI, साथ ही दो
गेटवे: Hermes, OpenClaw। नीति API और सेशन इतिहास साझा किए जाते हैं; कौन सी
घटनाएं ब्लॉक कर सकती हैं यह हार्नेस के अनुसार भिन्न होता है।

एजेंट जो उनमें से किसी में नहीं चलते हैं [Python SDK](https://docs.befailproof.ai/reference/custom-agents) के माध्यम से रिपोर्ट करते हैं,
जो आपको ट्रेसिंग, सेशन और ऑडिट देता है। वहाँ प्रवर्तन के लिए आपके अपने रनटाइम में एक हुक की आवश्यकता है — [हमसे संपर्क करें](mailto:support@befailproof.ai) और हम इसे मैप करेंगे।

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

## स्थापित करें

यदि आप चाहते हैं कि एक संगत एजेंट को Failproof AI कौशल दें ताकि यह सेटअप का मार्गदर्शन कर सके,
मशीन का निरीक्षण कर सके, और नीति, ऑडिट, सेशन और क्लाउड कार्य को सही तरीके से रूट कर सके:

```sh
npx skills add FailproofAI/skills
```

यह छतरी कौशल और इसके विशेषज्ञ भाई-बहनों को स्थापित करता है। केवल छतरी स्थापित करने के लिए,
`--skill failproofai` जोड़ें। कौशल संचालन निर्देश प्रदान करते हैं; उत्पाद स्वयं को स्थापित
और कॉन्फ़िगर करें:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

सेटअप समर्थित एजेंटों को जोड़ता है और पृष्ठभूमि सेवा स्थापित करता है। यह कोई नीति पैक नहीं चुनता: इससे पहले कि आप एक जोड़ें, केवल `block-failproofai-commands` चलता है
ताकि एजेंट Failproof AI को अक्षम न कर सके।

`failproofai config --token <machine-key>` के साथ बिना प्रॉम्प्ट के क्लाउड को कनेक्ट करें। साझा मशीन पर या CI में,
`FAILPROOFAI_CLOUD_TOKEN` सेट करें और `failproofai config` चलाएँ ताकि कुंजी कमांड इतिहास में दिखाई न दे।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `sanitize-api-keys` | API कुंजियाँ एजेंट के संदर्भ में लीक होने से |
| `block-env-files` | `.env` और अन्य गोपनीय फ़ाइलों को पढ़ने से |
| `warn-repeated-tool-calls` | एजेंट को एक ही कॉल पर लूप करने से |
| `block-sudo` | विशेषाधिकार उन्नयन से |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, असीमित `DELETE` से |
| `block-terraform` / `block-kubectl` | लाइव बुनियादी ढांचे में असमीक्षित परिवर्तन से |
| `block-rm-rf` | पुनरावर्ती फ़ाइल विलोपन से |
| `block-force-push` / `block-push-master` | `git push --force`, `main` पर प्रत्यक्ष पुश से |

ये नीतियाँ फ़ाइलों, क्रेडेंशियल्स, बुनियादी ढांचे, डेटाबेस और एजेंट
कार्यप्रवाह की सुरक्षा करती हैं। सटीक प्रवर्तन समर्थन हार्नेस और घटना के अनुसार भिन्न होता है।

→ [सभी 39 अंतर्निहित नीतियाँ](https://docs.befailproof.ai/policies/builtin)

---

## आपकी अपनी नीतियाँ

`.failproofai/policies/` में एक फ़ाइल ड्रॉप करें — यह स्वचालित रूप से लोड हो जाती है, किसी ध्वज की आवश्यकता नहीं।
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

तीन निर्णय उपलब्ध हैं प्रत्येक नीति के लिए:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | संचालन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे आगे बढ़ने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [कस्टम नीतियाँ गाइड](https://docs.befailproof.ai/policies/custom)

---

## नीति पैक

एक नीति पैक एक सार्वजनिक GitHub
रिपॉजिटरी से प्रकाशित नीतियों का एक संस्करणबद्ध सेट है। इसे स्थापित करने से पहले निरीक्षण करें:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

स्लैश वाली कोई भी चीज़ एक पैक स्रोत है; बिना किसी के कोई नीति नाम है।
आप चयनित श्रेणियाँ या नीतियाँ स्थापित कर सकते हैं, और आवश्यकता होने पर एक रिलीज़ को पिन कर सकते हैं।

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

[Policy Hub](https://befailproof.ai/policy-hub/) में प्रकाशित पैक ब्राउज़ करें, या
अपना स्वयं का शुरू करने के लिए `failproofai publish --init` चलाएँ। अवलोकन मोड एक पैक को रिकॉर्ड करने देता है कि यह क्या करता
बिना ब्लॉक किए: `failproofai publish --effect observe`।

→ [नीति पैक](https://docs.befailproof.ai/policies/packs) ·
[एक पैक प्रकाशित करें](https://docs.befailproof.ai/policies/publish-a-pack)

---

## अवलोकनशीलता

प्रवर्तन आधा है। दूसरा आधा है यह देखना कि एजेंट ने वास्तव में क्या किया।

`failproofai` को बिना तर्कों के चलाएँ और यह `localhost:8020` पर एक डैशबोर्ड परोसता है
पहले से आपकी मशीन पर चलने वाले इतिहास को पढ़ता है — कोई खाता नहीं, कोई साइन अप नहीं, कुछ भी बॉक्स से बाहर न जाए। आपको सेशन सूची, मॉडल कॉल का अनुक्रम, प्रत्येक रन में टूल कॉल
और हुक निर्णय, क्या ब्लॉक किया गया और नीति ने एजेंट को क्या बताया, और एक ऑफलाइन ऑडिट (`failproofai audit`) मिलता है जो आपके इतिहास को जोखिम भरे
पैटर्न के लिए स्कैन करता है और नीतियों का सुझाव देता है उन्हें रोकने के लिए।

→ [लोकल डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) ·
[एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) ·
[लोकल ऑडिट](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Observability** एक बेड़े में एजेंटों को चलाने वाली टीमों के लिए समान डेटा मॉडल का होस्ट किया गया पक्ष है: हर हार्नेस से हर रन एक जगह पर, एक निष्पादन ग्राफ अपनी स्वयं की लेन पर समानांतर उप-एजेंटों के साथ, मॉडल, उपकरण और हुक के लिए p50/p95/p99 विलंबता, प्रति-मॉडल लागत और संदर्भ-विंडो ट्रैकिंग, त्रुटि ट्रैकिंग, आपके अपने ट्रेस पर साझा करने योग्य डैशबोर्ड के साथ SQL, आपकी स्वयं की सेवा द्वारा स्कोर किए गए मूल्यांकन, अनुसूचित ऑडिट जो आवर्ती विफलताओं को साक्ष्य-समर्थित निष्कर्षों में बदलते हैं, और Slack, ईमेल या हस्ताक्षरित वेबहुक के लिए रूट किए गए सचेतन। एंटरप्राइज़ योजना पर आपके स्वयं के क्लस्टर में स्व-होस्टिंग उपलब्ध है।

→ [सेशन](https://docs.befailproof.ai/sessions/overview) ·
[ऑडिट](https://docs.befailproof.ai/audits/overview) ·
[डेमो बुक करें](https://befailproof.ai/get-a-demo)

---

## दस्तावेज़

| शुरुआत करें | |
|---|---|
| [त्वरित प्रारंभ](https://docs.befailproof.ai/start/quickstart) | स्थापित करें, एक हार्नेस कनेक्ट करें, पहला रन देखें |
| [अवधारणाएँ](https://docs.befailproof.ai/start/concepts) | हुक सिस्टम कैसे काम करता है |
| [समर्थित हार्नेस](https://docs.befailproof.ai/reference/harnesses) | सभी 12, और प्रत्येक क्या लागू कर सकता है |

| अवलोकन | |
|---|---|
| [सेशन](https://docs.befailproof.ai/sessions/overview) | एक रन का अनुसरण करें: मॉडल, उपकरण, त्रुटियाँ, विलंबता |
| [एक ट्रेस पढ़ें](https://docs.befailproof.ai/sessions/read-a-trace) | निष्पादन ग्राफ आपको क्या बता रहा है |
| [ऑडिट](https://docs.befailproof.ai/audits/overview) | कई सेशन में विफलता पैटर्न खोजें |
| [लोकल डैशबोर्ड](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, कोई खाता आवश्यक नहीं |

| प्रवर्तन | |
|---|---|
| [अंतर्निहित नीतियाँ](https://docs.befailproof.ai/policies/builtin) | सभी 39 नीतियाँ पैरामीटर के साथ |
| [कस्टम नीतियाँ](https://docs.befailproof.ai/policies/custom) | अपनी स्वयं की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/policies/local-configuration) | कॉन्फ़िग स्कोप और विलय नियम |

| अपने स्वयं के एजेंट को उपकरण से सजाएँ | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | बिना हार्नेस वाले एजेंट से रन रिपोर्ट करें |
| [नीति SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` संदर्भ |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए स्वतंत्र; failproofai के व्यावसायिक पुनर्विक्रय के लिए अलग समझौता की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](../../LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](../../CONTRIBUTING.md) देखें। नई नीतियाँ, किनारे के मामले, और अनुवाद सभी का स्वागत है।

> **शुरू करने से पहले बनाएँ।** पहले `bun install && bun run build` चलाएँ। यह रिपॉजिटरी failproofai के अपने हुक को स्वयं पर चलाता है, और वे `dist/` बंडल के विरुद्ध `failproofai` आयात को हल करते हैं — बिना बिल्ड के आप `Cannot find package 'failproofai'` हुक त्रुटियों में मार खाएंगे। `src/` बदलने के बाद पुनः निर्माण करें। [बिल्ड करें इनरेपो डेव हुक के काम करने से पहले](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

❤️ के साथ [befailproof.ai](https://befailproof.ai) द्वारा SF और बेंगलुरु में निर्मित।
