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
Claude Code और Codex में हुक करता है। लूप्स, खतरनाक कार्यों और गोपनीय रिसाव को रोकता है
इससे पहले कि वे समस्याएं बन जाएं। शून्य विलंबता। स्थानीय रूप से चलता है।

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
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> एक या किसी भी संयोजन के लिए हुक इंस्टॉल करें: `failproofai policies --install --cli opencode pi` (या `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`)। स्वचालित रूप से इंस्टॉल किए गए CLIs का पता लगाने और प्रॉम्प्ट करने के लिए `--cli` को छोड़ दें।
>
> **Hermes** (hermes-agent, एक Slack/Telegram गेटवे) **लाइव-हुक प्रवर्तन** (`--cli hermes` — एक इंस्टॉल हर प्लेटफॉर्म और सबएजेंट से टूल कॉल को रोकता है) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके गेटवे सेशन को एकल `~/.hermes/state.db` से फिर से चलाएं।
>
> **OpenClaw** (openclaw गेटवे, एक स्व-होस्टेड बहु-चैनल सहायक) **लाइव-हुक प्रवर्तन** (`--cli openclaw`, उपयोगकर्ता-स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके JSONL सेशन को फिर से चलाएं (`~/.openclaw/agents/<id>/sessions/*.jsonl`)। प्रवर्तन OpenClaw के **इन-प्रक्रिया प्लगइन हुक्स** का उपयोग करता है (एक प्रदान किया गया `openclaw-plugin/` जो failproofai को async-spawn करता है — इसके फाइल-आधारित आंतरिक हुक्स केवल अवलोकन-केवल हैं और ब्लॉक नहीं कर सकते): `before_tool_call` एक टूल को ब्लॉक करता है, और `before_agent_finalize` एक वास्तविक टर्न-अंत गेट है, इसलिए `require-*-before-stop` बिल्ट-इन प्रवर्तित होते हैं।
>
> **Factory Droid** (`droid`) **लाइव-हुक प्रवर्तन** (`--cli factory`, उपयोगकर्ता + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके ऑन-डिस्क JSONL सेशन को फिर से चलाएं। droid हुक **exit code 2** (एक JSON निर्णय नहीं) से टूल कॉल ब्लॉक करता है और केवल टर्न-अंत `Stop` इवेंट पर `{decision:"block"}` को सम्मानित करता है — failproofai प्रत्येक इवेंट के लिए स्वचालित रूप से सही आकार उत्सर्जित करता है।
>
> **Devin CLI** (`devin`, Cognition) **लाइव-हुक प्रवर्तन** (`--cli devin`, उपयोगकर्ता + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके SQLite सेशन को फिर से चलाएं (`~/.local/share/devin/cli/sessions.db`)। Devin एक **शुद्ध Claude-क्लोन** है — समान इवेंट नाम, समान snake_case पेलोड, समान `hooks`-रैपर कॉन्फ़िग (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — प्रत्येक इवेंट पर `{decision:"block"}` JSON के माध्यम से ब्लॉक करना।
>
> **Antigravity CLI** (`agy`) **लाइव-हुक प्रवर्तन** (`--cli antigravity`, उपयोगकर्ता + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके plain-JSONL सेशन को फिर से चलाएं (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`)। Antigravity के अपने अनुबंध हैं (Claude-क्लोन नहीं): एक **नामित-हुक** `hooks.json` स्कीमा (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), एक camelCase stdin पेलोड जो failproofai सामान्य करता है, और इसके अपने प्रतिक्रिया आकार — `{decision:"deny"}` एक टूल ब्लॉक करने के लिए, `{decision:"continue"}` `Stop` पर एक और टर्न के लिए, `{injectSteps}` मॉडल के चलने से पहले एक अनुस्मारक इंजेक्ट करने के लिए।
>
> **Goose** (codename goose, Block) **लाइव-हुक प्रवर्तन** (`--cli goose`, उपयोगकर्ता + प्रोजेक्ट स्कोप) और ऑफलाइन **ऑडिट** के लिए समर्थित है। इसके SQLite सेशन को फिर से चलाएं (`~/.local/share/goose/sessions/sessions.db`)। प्रवर्तन Goose के **hooks** सिस्टम का उपयोग करता है (cross-agent **Open Plugins** spec) — इंस्टॉलर बस एक प्लगइन dir को `~/.agents/plugins/failproofai/` पर ड्रॉप करता है और Goose इसे स्वचालित रूप से खोजता है। ब्लॉकिंग `PreToolUse` इवेंट पर `{"decision":"block"}` JSON है (जो शेल टूल और प्रतिनिधि सबएजेंट के अंदर फायर होता है), goose v1.43.0 के विरुद्ध लाइव सत्यापित; Goose के पास कोई टर्न-अंत `Stop` इवेंट नहीं है, इसलिए `require-*-before-stop` बिल्ट-इन लागू नहीं होते (Hermes की तरह)।

---

## इंस्टॉल करें

```sh
npm install -g failproofai
failproofai policies --install   # या बस `failproofai` चलाएं और पहली बार चलाने के प्रॉम्प्ट को स्वीकार करें
failproofai
```

30 बिल्ट-इन नीतियां तुरंत सक्रिय होती हैं। डैशबोर्ड `localhost:8020` पर। पहली बार चलाने के प्रॉम्प्ट को अक्षम करें `FAILPROOFAI_NO_FIRST_RUN=1` के साथ।

---

## यह क्या रोकता है

| नीति | यह क्या ब्लॉक करता है |
|---|---|
| `block-push-master` | `main` / `master` के लिए सीधे पुश |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` पर कमिट, मर्ज, rebase |
| `block-rm-rf` | रिकर्सिव फाइल हटाना |
| `sanitize-api-keys` | एजेंट संदर्भ में API कुंजियों का रिसाव |

→ [सभी 30 बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies)

---

## अपनी स्वयं की नीतियां

`.failproofai/policies/` में एक फाइल ड्रॉप करें — यह स्वचालित रूप से लोड होती है, कोई झंडे की आवश्यकता नहीं है।
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

प्रत्येक नीति के लिए उपलब्ध तीन निर्णय:

| निर्णय | प्रभाव |
|---|---|
| `allow()` | ऑपरेशन की अनुमति दें |
| `deny(message)` | इसे ब्लॉक करें — संदेश एजेंट को वापस जाता है |
| `instruct(message)` | इसे थ्रू करने दें, लेकिन एजेंट के अगले प्रॉम्प्ट में संदर्भ जोड़ें |

→ [कस्टम नीतियां गाइड](https://docs.befailproof.ai/custom-policies)

---

## सेशन दृश्यता

आपका एजेंट हर टूल कॉल करता है वह स्थानीय रूप से लॉग किया जाता है। डैशबोर्ड दिखाता है कि क्या चलता है,
क्या ब्लॉक किया गया था, और नीति ने एजेंट को क्या बताया — इसलिए आप अनुमान नहीं लगा रहे हैं
जब कुछ गलत हो जाता है। → [डैशबोर्ड गाइड](https://docs.befailproof.ai/dashboard)

---

## डॉक्यूमेंटेशन

| | |
|---|---|
| [शुरुआत करना](https://docs.befailproof.ai/getting-started) | इंस्टॉलेशन और पहले कदम |
| [बिल्ट-इन नीतियां](https://docs.befailproof.ai/built-in-policies) | सभी 30 नीतियां पैरामीटर के साथ |
| [कस्टम नीतियां](https://docs.befailproof.ai/custom-policies) | अपनी स्वयं की लिखें |
| [कॉन्फ़िगरेशन](https://docs.befailproof.ai/configuration) | कॉन्फ़िग स्कोप और मर्ज नियम |
| [डैशबोर्ड](https://docs.befailproof.ai/dashboard) | सेशन मॉनिटर और नीति गतिविधि |
| [आर्किटेक्चर](https://docs.befailproof.ai/architecture) | हुक सिस्टम कैसे काम करता है |

---

## लाइसेंस

MIT with [Commons Clause](https://commonsclause.com/) — आंतरिक और व्यक्तिगत उपयोग के लिए निःशुल्क; failproofai स्वयं के वाणिज्यिक पुनर्विक्रय के लिए एक अलग समझौते की आवश्यकता है। पूर्ण पाठ के लिए [LICENSE](./LICENSE) देखें।

---

## योगदान

[CONTRIBUTING.md](./CONTRIBUTING.md) देखें। नई नीतियां, किनारे के मामले, और अनुवाद सभी स्वागत हैं।

> **शुरुआत करने से पहले बिल्ड करें।** पहले `bun install && bun run build` चलाएं। यह रेपो failproofai के अपने हुक्स को स्वयं पर चलाता है, और वे `failproofai` आयात को संकलित `dist/` बंडल के विरुद्ध समाधान करते हैं — बिल्ड के बिना आप `Cannot find package 'failproofai'` हुक त्रुटि मारेंगे। `src/` बदलने के बाद रीबिल्ड करें। [इन-रेपो डेव हुक्स के काम करने से पहले बिल्ड करें](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) देखें।

---

[Nivedit Jain](https://github.com/NiveditJain) और [Nikita Agarwal](https://github.com/nk-ag) द्वारा निर्मित।
[befailproof.ai](https://befailproof.ai)
