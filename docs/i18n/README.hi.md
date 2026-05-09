> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | **🇮🇳 हिन्दी** | [🇹🇷 Türkçe](README.tr.md) | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

```
    ______      _ __                       ____   ___    ____
   / ____/___ _(_) /___  _________  ____  / __/  /   |  /  _/
  / /_  / __ `/ / / __ \/ ___/ __ \/ __ \/ /_   / /| |  / /
 / __/ / /_/ / / / /_/ / /  / /_/ / /_/ / __/  / ___ |_/ /
/_/    \__,_/_/_/ .___/_/   \____/\____/_/    /_/  |_/___/
               /_/
```

# Failproof AI

[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://befailproof.ai)
[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/exospherehost/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/exospherehost/failproofai/actions)
[![Slack](https://img.shields.io/badge/Slack-join%20us-4A154B?style=flat-square&logo=slack)](https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ)

**अनुवाद**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

अपने AI एजेंट्स को विश्वसनीय, कार्य-केंद्रित और स्वायत्त रूप से चलाने वाली नीतियों को प्रबंधित करने का सबसे आसान तरीका - **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(बीटा)_, **Cursor Agent** _(बीटा)_, **OpenCode** _(बीटा)_, **Pi** _(बीटा)_, **Gemini CLI** _(बीटा)_ और **Agents SDK** के लिए।

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

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

> एक या किसी भी संयोजन के लिए हुक स्थापित करें: `failproofai policies --install --cli opencode pi gemini` (या `--cli claude codex copilot cursor opencode pi gemini`)। स्वचालित रूप से स्थापित CLIs का पता लगाने और संकेत देने के लिए `--cli` को छोड़ दें। **GitHub Copilot CLI, Cursor Agent, OpenCode, Pi, और Gemini CLI समर्थन बीटा में हैं — परीक्षण जारी है।**

- **39 बिल्ट-इन नीतियां** - सामान्य एजेंट विफलता मोड को तुरंत पकड़ें। विनाशकारी कमांड को ब्लॉक करें, गोपनीयता रिसाव को रोकें, एजेंट्स को प्रोजेक्ट सीमाओं में रखें, लूप का पता लगाएं और बहुत कुछ।
- **कस्टम नीतियां** - JavaScript में अपने स्वयं की विश्वसनीयता नियम लिखें। `allow`/`deny`/`instruct` API का उपयोग करके सम्मेलन लागू करें, बहाव को रोकें, संचालन को नियंत्रित करें, या बाहरी सिस्टम के साथ एकीकृत करें।
- **आसान कॉन्फ़िगरेशन** - कोड लिखे बिना किसी भी नीति को समायोजित करें। प्रति-प्रोजेक्ट या वैश्विक रूप से अनुमति सूची, सुरक्षित शाखाएं, दहलीज सेट करें। तीन-स्कोप कॉन्फ़िग स्वचालित रूप से मर्ज हो जाती हैं।
- **एजेंट मॉनिटर** - देखें कि आपके एजेंट्स आपके दूर रहते हुए क्या करते थे। सेशन ब्राउज़ करें, प्रत्येक टूल कॉल का निरीक्षण करें, और ठीक से देखें कि नीतियां कहां सक्रिय हुईं।

सब कुछ स्थानीय रूप से चलता है - कोई डेटा आपकी मशीन से नहीं निकलता।

---

## आवश्यकताएं

- Node.js >= 20.9.0
- Bun >= 1.3.0 (वैकल्पिक - केवल विकास / स्रोत से निर्माण के लिए आवश्यक)

---

## इंस्टॉल करें

```bash
npm install -g failproofai
# या
bun add -g failproofai
```

---

## त्वरित प्रारंभ

### 1. नीतियों को वैश्विक रूप से सक्षम करें

```bash
failproofai policies --install
```

`~/.claude/settings.json` में हुक प्रविष्टियां लिखता है। Claude Code अब प्रत्येक टूल कॉल से पहले और बाद में failproofai को आमंत्रित करेगा।

### 2. डैशबोर्ड लॉन्च करें

```bash
failproofai
```

`http://localhost:8020` खोलता है - सेशन ब्राउज़ करें, लॉग निरीक्षण करें, नीतियां प्रबंधित करें।

### 3. देखें कि क्या सक्रिय है

```bash
failproofai policies
```

---

## नीति स्थापना

### दायरे

| दायरा | कमांड | कहां लिखता है |
|-------|---------|-----------------|
| वैश्विक (डिफ़ॉल्ट) | `failproofai policies --install` | `~/.claude/settings.json` |
| प्रोजेक्ट | `failproofai policies --install --scope project` | `.claude/settings.json` |
| स्थानीय | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### विशिष्ट नीतियों को इंस्टॉल करें

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### नीतियां हटाएं

```bash
failproofai policies --uninstall
# या किसी विशिष्ट दायरे के लिए:
failproofai policies --uninstall --scope project
```

---

## कॉन्फ़िगरेशन

नीति कॉन्फ़िगरेशन `~/.failproofai/policies-config.json` (वैश्विक) में या आपके प्रोजेक्ट में `.failproofai/policies-config.json` (प्रति-प्रोजेक्ट) में रहती है।

```json
{
  "enabledPolicies": [
    "block-sudo",
    "block-rm-rf",
    "sanitize-api-keys",
    "block-push-master",
    "block-env-files",
    "block-read-outside-cwd"
  ],
  "policyParams": {
    "block-sudo": {
      "allowPatterns": ["sudo systemctl status", "sudo journalctl"],
      "hint": "sudo के बिना सीधे apt-get का उपयोग करें।"
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "इसके बजाय एक ताजी शाखा बनाने का प्रयास करें।"
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API key" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**तीन कॉन्फ़िग दायरे** स्वचालित रूप से मर्ज हो जाते हैं (प्रोजेक्ट → स्थानीय → वैश्विक)। पूर्ण मर्ज नियमों के लिए [docs/configuration.mdx](docs/configuration.mdx) देखें।

---

## बिल्ट-इन नीतियां

| नीति | विवरण | कॉन्फ़िगर योग्य |
|--------|-------------|:---:|
| `block-sudo` | एजेंट्स को विशेषाधिकार प्राप्त सिस्टम कमांड चलाने से रोकें | `allowPatterns` |
| `block-rm-rf` | आकस्मिक पुनरावर्ती फ़ाइल विलोपन को रोकें | `allowPaths` |
| `block-curl-pipe-sh` | एजेंट्स को अविश्वसनीय स्क्रिप्ट को शेल में पाइप करने से रोकें | |
| `block-failproofai-commands` | स्व-विस्थापन को रोकें | |
| `sanitize-jwt` | JWT टोकन को एजेंट संदर्भ में रिसाव होने से रोकें | |
| `sanitize-api-keys` | API कुंजियों को एजेंट संदर्भ में रिसाव होने से रोकें | `additionalPatterns` |
| `sanitize-connection-strings` | डेटाबेस क्रेडेंशियल को एजेंट संदर्भ में रिसाव होने से रोकें | |
| `sanitize-private-key-content` | आउटपुट से PEM निजी कुंजी ब्लॉक को हटाएं | |
| `sanitize-bearer-tokens` | आउटपुट से प्राधिकरण Bearer टोकन को हटाएं | |
| `block-env-files` | एजेंट्स को .env फ़ाइलें पढ़ने से रोकें | |
| `protect-env-vars` | एजेंट्स को पर्यावरण चर मुद्रित करने से रोकें | |
| `block-read-outside-cwd` | एजेंट्स को प्रोजेक्ट सीमाओं के अंदर रखें | `allowPaths` |
| `block-secrets-write` | निजी कुंजी और प्रमाणपत्र फ़ाइलों में लिखने को रोकें | `additionalPatterns` |
| `block-push-master` | मुख्य/मास्टर में आकस्मिक पुश को रोकें | `protectedBranches` |
| `block-work-on-main` | एजेंट्स को सुरक्षित शाखाओं से दूर रखें | `protectedBranches` |
| `block-force-push` | `git push --force` को रोकें | |
| `warn-git-amend` | कमिट को संशोधित करने से पहले एजेंट्स को याद दिलाएं | |
| `warn-git-stash-drop` | स्टैश ड्रॉप करने से पहले एजेंट्स को याद दिलाएं | |
| `warn-all-files-staged` | आकस्मिक `git add -A` को पकड़ें | |
| `warn-destructive-sql` | निष्पादन से पहले DROP/DELETE SQL को पकड़ें | |
| `warn-schema-alteration` | निष्पादन से पहले ALTER TABLE को पकड़ें | |
| `warn-large-file-write` | अप्रत्याशित रूप से बड़ी फ़ाइल लिखने को पकड़ें | `thresholdKb` |
| `warn-package-publish` | आकस्मिक `npm publish` को पकड़ें | |
| `warn-background-process` | अनपेक्षित पृष्ठभूमि प्रक्रिया लॉन्च को पकड़ें | |
| `warn-global-package-install` | अनपेक्षित वैश्विक पैकेज इंस्टॉल को पकड़ें | |
| …और अधिक | | |

पूर्ण नीति विवरण और पैरामीटर संदर्भ: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## कस्टम नीतियां

एजेंट्स को विश्वसनीय और कार्य-केंद्रित रखने के लिए अपनी स्वयं की नीतियां लिखें:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Block writes to paths containing 'production'",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Writes to production paths are blocked");
    return allow();
  },
});
```

निम्नलिखित के साथ इंस्टॉल करें:

```bash
failproofai policies --install --custom ./my-policies.js
```

### निर्णय सहायक

| फ़ंक्शन | प्रभाव |
|----------|--------|
| `allow()` | ऑपरेशन को अनुमति दें |
| `allow(message)` | अनुमति दें और Claude को सूचनात्मक संदर्भ भेजें |
| `deny(message)` | ऑपरेशन को ब्लॉक करें; Claude को संदेश दिखाया जाता है |
| `instruct(message)` | Claude के प्रॉम्प्ट में संदर्भ जोड़ें; ब्लॉक नहीं करता है |

### संदर्भ ऑब्जेक्ट (`ctx`)

| क्षेत्र | प्रकार | विवरण |
|-------|------|-------------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | टूल जिसे बुलाया जा रहा है (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | टूल के इनपुट पैरामीटर |
| `payload` | `object` | पूर्ण कच्ची इवेंट पेलोड |
| `session.cwd` | `string` | Claude Code सेशन की कार्य निर्देशिका |
| `session.sessionId` | `string` | सेशन पहचानकर्ता |
| `session.transcriptPath` | `string` | सेशन प्रतिलेख फ़ाइल का पथ |

कस्टम हुक transitive स्थानीय आयातों, async/await, और `process.env` तक पहुंच का समर्थन करते हैं। त्रुटियां fail-open हैं (लॉग किए गए `~/.failproofai/hook.log` में, बिल्ट-इन नीतियां जारी रहती हैं)। पूर्ण गाइड के लिए [docs/custom-hooks.mdx](docs/custom-hooks.mdx) देखें।

### सम्मेलन-आधारित नीतियां

`.failproofai/policies/` में `*policies.{js,mjs,ts}` फ़ाइलें ड्रॉप करें और वे स्वचालित रूप से लोड हो जाती हैं — कोई फ्लैग या कॉन्फ़िग परिवर्तन की आवश्यकता नहीं। डिरेक्टरी को git में कमिट करें और हर टीम के सदस्य को स्वचालित रूप से समान गुणवत्ता मान मिलते हैं।

```text
# प्रोजेक्ट स्तर — git में कमिट किया गया, टीम के साथ साझा किया गया
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# उपयोगकर्ता स्तर — व्यक्तिगत, सभी प्रोजेक्ट पर लागू होता है
~/.failproofai/policies/my-policies.mjs
```

दोनों स्तर लोड होते हैं (union)। फ़ाइलें प्रत्येक निर्देशिका के भीतर वर्णानुक्रम में लोड की जाती हैं। क्रम को नियंत्रित करने के लिए `01-`, `02-`, आदि से उपसर्ग करें। जैसे ही आपकी टीम नई विफलता मोड की खोज करती है, एक नीति जोड़ें और पुश करें — हर कोई अपने अगले पुल पर अपडेट प्राप्त करता है। तैयार-से-उपयोग करने के लिए उदाहरणों के लिए [examples/convention-policies/](examples/convention-policies/) देखें।

---

## टेलीमेट्री

Failproof AI, PostHog के माध्यम से अनाम उपयोग टेलीमेट्री एकत्र करता है ताकि सुविधा उपयोग को समझा जा सके। कोई सेशन सामग्री, फ़ाइल नाम, टूल इनपुट, या व्यक्तिगत जानकारी कभी नहीं भेजी जाती है।

इसे अक्षम करें:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## दस्तावेज़

| गाइड | विवरण |
|-------|-------------|
| [शुरुआत करें](docs/getting-started.mdx) | स्थापन और पहले कदम |
| [बिल्ट-इन नीतियां](docs/built-in-policies.mdx) | सभी 39 बिल्ट-इन नीतियां पैरामीटर के साथ |
| [कस्टम नीतियां](docs/custom-policies.mdx) | अपनी स्वयं की नीतियां लिखें |
| [कॉन्फ़िगरेशन](docs/configuration.mdx) | कॉन्फ़िग फ़ाइल प्रारूप और दायरे मर्जिंग |
| [डैशबोर्ड](docs/dashboard.mdx) | सेशन मॉनिटर करें और नीति गतिविधि की समीक्षा करें |
| [आर्किटेक्चर](docs/architecture.mdx) | हुक सिस्टम कैसे काम करता है |
| [परीक्षण](docs/testing.mdx) | परीक्षण चलाएं और नए लिखें |

### डॉक्स को स्थानीय रूप से चलाएं

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

`http://localhost:3000` पर Mintlify डॉक्स साइट खोलता है। कंटेनर परिवर्तन देखता है यदि आप डॉक्स निर्देशिका को माउंट करते हैं:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## failproofai योगदानकर्ताओं के लिए नोट

इस रेपो का `.claude/settings.json` मानक `npx -y failproofai` कमांड के बजाय `bun ./bin/failproofai.mjs --hook <EventType>` का उपयोग करता है। यह इसलिए है क्योंकि failproofai प्रोजेक्ट के अंदर `npx -y failproofai` चलाने से एक स्व-संदर्भमय संघर्ष बनता है।

अन्य सभी रेपोज के लिए, अनुशंसित दृष्टिकोण `npx -y failproofai` है, जो इसके माध्यम से स्थापित है:

```bash
failproofai policies --install --scope project
```

## योगदान

[CONTRIBUTING.md](CONTRIBUTING.md) देखें।

---

## लाइसेंस

[LICENSE](LICENSE) देखें।

---

**ExosphereHost द्वारा निर्मित और रक्षणाबल्ली: आपके एजेंट्स के लिए विश्वसनीयता अनुसंधान प्रयोगशाला**। हम अपने स्वयं के एजेंट्स, सॉफ़्टवेयर और विशेषज्ञता के माध्यम से उद्यमों और स्टार्टअप्स को उनके AI एजेंट्स की विश्वसनीयता में सुधार करने में मदद करते हैं। [exosphere.host](https://exosphere.host) पर और जानें।
