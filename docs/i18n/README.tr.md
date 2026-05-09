> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Çeviriler**: [简体中文](docs/i18n/README.zh.md) | [日本語](docs/i18n/README.ja.md) | [한국어](docs/i18n/README.ko.md) | [Español](docs/i18n/README.es.md) | [Português](docs/i18n/README.pt-br.md) | [Deutsch](docs/i18n/README.de.md) | [Français](docs/i18n/README.fr.md) | [Русский](docs/i18n/README.ru.md) | [हिन्दी](docs/i18n/README.hi.md) | [Türkçe](docs/i18n/README.tr.md) | [Tiếng Việt](docs/i18n/README.vi.md) | [Italiano](docs/i18n/README.it.md) | [العربية](docs/i18n/README.ar.md) | [עברית](docs/i18n/README.he.md)

AI aracılarınızı güvenilir, odaklanmış ve otonom olarak çalışmaya tutmak için politikaları yönetmek için en kolay yol - **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ ve **Agents SDK** için.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI in action" width="800" />
</p>

## Desteklenen aracı CLI'ları

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

> Hook'ları bir veya birden fazla kombinasyon için yükleyin: `failproofai policies --install --cli opencode pi gemini` (veya `--cli claude codex copilot cursor opencode pi gemini`). Kurulu CLI'ları otomatik olarak algılamak ve soruyu sormak için `--cli` komutunu atlayın. **GitHub Copilot CLI, Cursor Agent, OpenCode, Pi ve Gemini CLI desteği beta aşamasındadır — test devam etmektedir.**

- **39 Yerleşik Politika** - Ortak aracı hata modlarını hazır olarak yakalayın. Yıkıcı komutları blokleyin, gizli bilgi sızıntısını önleyin, aracıları proje sınırları içinde tutun, döngüleri algılayın ve daha fazlasını yapın.
- **Özel Politikalar** - JavaScript'te kendi güvenilirlik kurallarınızı yazın. `allow`/`deny`/`instruct` API'sini kullanarak kuralları uygulayın, sapmaları önleyin, işlemleri kontrole alın veya harici sistemlerle entegre olun.
- **Kolay Yapılandırma** - Kod yazmadan herhangi bir politikayı ayarlayın. İzin listelerini, korunan dalları, eşikleri proje başına veya global olarak ayarlayın. Üç kapsamlı konfigürasyon otomatik olarak birleşir.
- **Aracı İzleyicisi** - Aracılarınızın sizin yokken ne yaptığını görün. Oturumlarında gezinin, her araç çağrısını inceleyin ve politikaların tam olarak nerede ateşlendiğini gözden geçirin.

Her şey yerel olarak çalışır - veri makinenizi terk etmez.

---

## Gereksinimler

- Node.js >= 20.9.0
- Bun >= 1.3.0 (isteğe bağlı - sadece geliştirme / kaynaktan derleme için gereklidir)

---

## Yükleme

```bash
npm install -g failproofai
# veya
bun add -g failproofai
```

---

## Hızlı başlangıç

### 1. Politikaları global olarak etkinleştir

```bash
failproofai policies --install
```

Hook girdilerini `~/.claude/settings.json` dosyasına yazar. Claude Code artık her araç çağrısından önce ve sonra failproofai'yi çağıracaktır.

### 2. Panoyu başlat

```bash
failproofai
```

`http://localhost:8020` adresini açar - oturumlar arasında gezinin, günlükleri inceleyin, politikaları yönetin.

### 3. Aktivleri kontrol et

```bash
failproofai policies
```

---

## Politika yüklemesi

### Kapsamlar

| Kapsam | Komut | Nereye yazıldığı |
|--------|-------|-----------------|
| Global (varsayılan) | `failproofai policies --install` | `~/.claude/settings.json` |
| Proje | `failproofai policies --install --scope project` | `.claude/settings.json` |
| Yerel | `failproofai policies --install --scope local` | `.claude/settings.local.json` |

### Belirli politikaları yükleyin

```bash
failproofai policies --install block-sudo block-rm-rf sanitize-api-keys
```

### Politikaları kaldırın

```bash
failproofai policies --uninstall
# veya belirli bir kapsam için:
failproofai policies --uninstall --scope project
```

---

## Yapılandırma

Politika yapılandırması `~/.failproofai/policies-config.json` dosyasında (global) veya projenizin `.failproofai/policies-config.json` dosyasında (proje başına) bulunur.

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
      "hint": "apt-get kullanın sudo olmadan."
    },
    "block-push-master": {
      "protectedBranches": ["main", "release", "prod"],
      "hint": "Bunun yerine yeni bir dal oluşturmayı deneyin."
    },
    "sanitize-api-keys": {
      "additionalPatterns": [
        { "regex": "myco_[A-Za-z0-9]{32}", "label": "MyCo API anahtarı" }
      ]
    },
    "warn-large-file-write": {
      "thresholdKb": 512
    }
  }
}
```

**Üç konfigürasyon kapsamı** otomatik olarak birleştirilir (proje → yerel → global). Tam birleştirme kuralları için [docs/configuration.mdx](docs/configuration.mdx) dosyasına bakın.

---

## Yerleşik politikalar

| Politika | Açıklama | Yapılandırılabilir |
|----------|----------|:---:|
| `block-sudo` | Aracıların ayrıcalıklı sistem komutları çalıştırmasını önleyin | `allowPatterns` |
| `block-rm-rf` | İstenmeden yapılan özyinelemeli dosya silmeyi önleyin | `allowPaths` |
| `block-curl-pipe-sh` | Aracıların güvenilmeyen betikleri kabuğa boru ile iletmesini önleyin | |
| `block-failproofai-commands` | Kendi kaldırılmasını önleyin | |
| `sanitize-jwt` | JWT belirteçlerinin aracı bağlamına sızmasını durdurun | |
| `sanitize-api-keys` | API anahtarlarının aracı bağlamına sızmasını durdurun | `additionalPatterns` |
| `sanitize-connection-strings` | Veritabanı kimlik bilgilerinin aracı bağlamına sızmasını durdurun | |
| `sanitize-private-key-content` | PEM özel anahtar bloklarını çıktıdan düzeltin | |
| `sanitize-bearer-tokens` | Authorization Bearer belirteçlerini çıktıdan düzeltin | |
| `block-env-files` | Aracıların .env dosyalarını okumasını tutun | |
| `protect-env-vars` | Aracıların ortam değişkenlerini yazdırmasını önleyin | |
| `block-read-outside-cwd` | Aracıları proje sınırları içinde tutun | `allowPaths` |
| `block-secrets-write` | Özel anahtar ve sertifika dosyalarına yazmaları önleyin | `additionalPatterns` |
| `block-push-master` | Ana/master'a istenmeden yapılan göndermeleri önleyin | `protectedBranches` |
| `block-work-on-main` | Aracıları korunan dallardan tutun | `protectedBranches` |
| `block-force-push` | `git push --force` komutunu önleyin | |
| `warn-git-amend` | Aracıları commit'leri değiştirmeden önce uyarın | |
| `warn-git-stash-drop` | Aracıları stash'leri bırakmadan önce uyarın | |
| `warn-all-files-staged` | İstenmeden yapılan `git add -A` komutlarını yakalayın | |
| `warn-destructive-sql` | DROP/DELETE SQL komutlarını yürütmeden önce yakalayın | |
| `warn-schema-alteration` | ALTER TABLE komutlarını yürütmeden önce yakalayın | |
| `warn-large-file-write` | Beklenmedik şekilde büyük dosya yazımlarını yakalayın | `thresholdKb` |
| `warn-package-publish` | İstenmeden yapılan `npm publish` komutlarını yakalayın | |
| `warn-background-process` | İstenmeyen arka plan süreci başlatmalarını yakalayın | |
| `warn-global-package-install` | İstenmeyen global paket yüklemelerini yakalayın | |
| …ve daha fazlası | | |

Tam politika ayrıntıları ve parametre başvurusu: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Özel politikalar

Aracılarınızı güvenilir ve odaklanmış tutmak için kendi politikalarınızı yazın:

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

Aşağıdakiyle kurun:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Karar yardımcıları

| İşlev | Etki |
|-------|------|
| `allow()` | İşleme izin verin |
| `allow(message)` | İzin verin ve Claude'a bilgilendirici bağlam gönderin |
| `deny(message)` | İşlemi blokleyin; mesaj Claude'a gösterilir |
| `instruct(message)` | Claude'un istemine bağlam ekleyin; bloklemez |

### Bağlam nesnesi (`ctx`)

| Alan | Tür | Açıklama |
|------|-----|----------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | Çağrılan araç (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | Aracın giriş parametreleri |
| `payload` | `object` | Tam ham olay yükü |
| `session.cwd` | `string` | Claude Code oturumunun çalışma dizini |
| `session.sessionId` | `string` | Oturum tanımlayıcısı |
| `session.transcriptPath` | `string` | Oturum transkripti dosyasının yolu |

Özel hook'lar geçişli yerel içe aktarmaları, async/await'i ve `process.env` erişimini destekler. Hatalar açık başarısız olur (hata `~/.failproofai/hook.log` dosyasına kaydedilir, yerleşik politikalar devam eder). Tam kılavuz için [docs/custom-hooks.mdx](docs/custom-hooks.mdx) dosyasına bakın.

### Kural tabanlı politikalar

`*policies.{js,mjs,ts}` dosyalarını `.failproofai/policies/` dizinine bırakın ve otomatik olarak yüklenir — bayrak veya konfigürasyon değişiklikleri gerekmez. Dizini git'e commit edin ve her takım üyesi otomatik olarak aynı kalite standartlarını alır.

```text
# Proje düzeyi — git'e commit edilmiş, takımla paylaşılmış
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Kullanıcı düzeyi — kişisel, tüm projelere uygulanır
~/.failproofai/policies/my-policies.mjs
```

Her iki düzey de yüklenir (birleşim). Dosyalar her dizinde alfabetik olarak yüklenir. Sırayı kontrol etmek için `01-`, `02-` vb. ile ön ek ekleyin. Takımınız yeni hata modlarını keşfettikçe bir politika ekleyin ve gönderin — herkes bir sonraki pull'da güncellemeyi alır. Hazır kullanım örnekleri için [examples/convention-policies/](examples/convention-policies/) dosyasına bakın.

---

## Telemetri

Failproof AI, özellik kullanımını anlamak için PostHog aracılığıyla anonim kullanım telemetrisi toplar. Oturum içeriği, dosya adları, araç girdileri veya kişisel bilgiler hiçbir zaman gönderilmez.

Devre dışı bırakın:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Belgeler

| Kılavuz | Açıklama |
|--------|----------|
| [Getting Started](docs/getting-started.mdx) | Yükleme ve ilk adımlar |
| [Built-in Policies](docs/built-in-policies.mdx) | 39 yerleşik politika ve parametreleri |
| [Custom Policies](docs/custom-policies.mdx) | Kendi politikalarınızı yazın |
| [Configuration](docs/configuration.mdx) | Konfigürasyon dosyası biçimi ve kapsam birleştirmesi |
| [Dashboard](docs/dashboard.mdx) | Oturumları izleyin ve politika etkinliğini gözden geçirin |
| [Architecture](docs/architecture.mdx) | Hook sistemi nasıl çalışır |
| [Testing](docs/testing.mdx) | Testleri çalıştırın ve yeni olanlar yazın |

### Dokümanları yerel olarak çalıştırın

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

Mintlify belgeleri sitesini `http://localhost:3000` adresinde açar. Belgeler dizinini bağlarsanız konteyner değişiklikleri izler:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## failproofai katkı sağlayanlar için not

Bu depo'nun `.claude/settings.json` dosyası `bun ./bin/failproofai.mjs --hook <EventType>` komutunu standart `npx -y failproofai` komutu yerine kullanır. Bunun nedeni, failproofai projesi içinde `npx -y failproofai` çalıştırmanın kendi kendine referans çatışması yaratmasıdır.

Diğer tüm depolar için önerilen yaklaşım `npx -y failproofai` komutudur ve şu şekilde yüklenir:

```bash
failproofai policies --install --scope project
```

## Katkıda Bulun

[CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

---

## Lisans

[LICENSE](LICENSE) dosyasına bakın.

---

**ExosphereHost: Reliability Research Lab for Your Agents** tarafından oluşturulmuş ve yönetilmektedir. Kurumsal ve başlangıç şirketlerinin kendi aracıları, yazılımı ve uzmanlığı aracılığıyla AI aracılarının güvenilirliğini geliştirmelerine yardımcı oluruz. [exosphere.host](https://exosphere.host) adresinden daha fazla bilgi edinin.
