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

AI ajanlarınızı güvenilir, odaklı ve otonom olarak çalışan halde tutmak için politikaları yönetmenin en kolay yolu - **Claude Code**, **OpenAI Codex**, **GitHub Copilot CLI** _(beta)_, **Cursor Agent** _(beta)_, **OpenCode** _(beta)_, **Pi** _(beta)_, **Gemini CLI** _(beta)_ & **Agents SDK** için.

<p align="center">
  <img src="failproofai-hq.gif" alt="Failproof AI in action" width="800" />
</p>

## Desteklenen ajans CLI'ları

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

> Hook'ları tek bir veya herhangi bir kombinasyon için yükleyin: `failproofai policies --install --cli opencode pi gemini` (veya `--cli claude codex copilot cursor opencode pi gemini`). `--cli` parametresini atlayarak yüklü CLI'ları otomatik olarak algılatıp seçim yapmak isteyebilirsiniz. **GitHub Copilot CLI, Cursor Agent, OpenCode, Pi ve Gemini CLI desteği beta aşamasındadır — testler devam etmektedir.**

- **39 Yerleşik Politika** - Yaygın ajans hatasını hemen tespit edin. Yıkıcı komutları engelleyin, gizli diziler sızmasını önleyin, ajanları proje sınırları içinde tutun, döngüleri algılayın ve daha fazlası.
- **Özel Politikalar** - JavaScript'te kendi güvenilirlik kurallarınızı yazın. Kuralları uygulamak, kaymaları önlemek, işlemleri kapılaştırmak veya dış sistemlerle entegre olmak için `allow`/`deny`/`instruct` API'sini kullanın.
- **Kolay Yapılandırma** - Kod yazmadan herhangi bir politikayı ayarlayın. İzin listelerini ayarlayın, korunan dalları seçin, eşikleri proje başına veya global olarak belirleyin. Üç kapsam yapılandırması otomatik olarak birleştirilir.
- **Ajans Monitörü** - Ajanlarınız yokken neler yaptığını görün. Oturumları inceleyin, her araç çağrısını denetleyin ve politikaların tam olarak nerede etkinleştiğini gözden geçirin.

Her şey yerel olarak çalışır - hiçbir veri makinenizi terk etmez.

---

## Gereksinimler

- Node.js >= 20.9.0
- Bun >= 1.3.0 (isteğe bağlı - sadece geliştirme / kaynaktan derlemek için gerekli)

---

## Yükleme

```bash
npm install -g failproofai
# veya
bun add -g failproofai
```

---

## Hızlı başlangıç

### 1. Politikaları global olarak etkinleştirin

```bash
failproofai policies --install
```

`~/.claude/settings.json` dosyasına hook girişlerini yazar. Claude Code artık her araç çağrısından önce ve sonra failproofai'yi çağıracaktır.

### 2. Panoyu açın

```bash
failproofai
```

`http://localhost:8020` açılır - oturumları inceleyin, günlükleri görüntüleyin, politikaları yönetin.

### 3. Aktif olanları kontrol edin

```bash
failproofai policies
```

---

## Politika kurulumu

### Kapsamlar

| Kapsam | Komut | Nereye yazılır |
|--------|---------|-----------------|
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

Politika yapılandırması `~/.failproofai/policies-config.json` (global) veya projenizde `.failproofai/policies-config.json` dosyasında bulunur.

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
      "hint": "sudo kullanmadan apt-get'i doğrudan kullanın."
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

**Üç yapılandırma kapsamı** otomatik olarak birleştirilir (proje → yerel → global). Tam birleştirme kuralları için [docs/configuration.mdx](docs/configuration.mdx) dosyasını inceleyebilirsiniz.

---

## Yerleşik politikalar

| Politika | Açıklama | Yapılandırılabilir |
|--------|-------------|:---:|
| `block-sudo` | Ajanları ayrıcalıklı sistem komutlarını çalıştırmaktan engelle | `allowPatterns` |
| `block-rm-rf` | Tesadüfi özyineli dosya silmesini engelle | `allowPaths` |
| `block-curl-pipe-sh` | Ajanları güvenilmez komut dosyalarını shell'e yönlendirmekten engelle | |
| `block-failproofai-commands` | Kendi kaldırılmasını engelle | |
| `sanitize-jwt` | JWT belirteçlerinin ajans bağlamına sızmasını durdur | |
| `sanitize-api-keys` | API anahtarlarının ajans bağlamına sızmasını durdur | `additionalPatterns` |
| `sanitize-connection-strings` | Veritabanı kimlik bilgilerinin ajans bağlamına sızmasını durdur | |
| `sanitize-private-key-content` | PEM özel anahtar bloklarını çıktıdan redakte et | |
| `sanitize-bearer-tokens` | Authorization Bearer belirteçlerini çıktıdan redakte et | |
| `block-env-files` | Ajanları .env dosyalarını okumaktan engelle | |
| `protect-env-vars` | Ajanları ortam değişkenlerini yazdırmaktan engelle | |
| `block-read-outside-cwd` | Ajanları proje sınırları içinde tut | `allowPaths` |
| `block-secrets-write` | Özel anahtar ve sertifika dosyalarına yazmaları engelle | `additionalPatterns` |
| `block-push-master` | Tesadüfi ana/master dalına göndermeyi engelle | `protectedBranches` |
| `block-work-on-main` | Ajanları korunan dallardan uzak tut | `protectedBranches` |
| `block-force-push` | `git push --force`'u engelle | |
| `warn-git-amend` | Ajanları commit'i değiştirmeden önce uyar | |
| `warn-git-stash-drop` | Ajanları stash'i bırakmadan önce uyar | |
| `warn-all-files-staged` | Tesadüfi `git add -A`'yı yakala | |
| `warn-destructive-sql` | DROP/DELETE SQL'ini yürütmeden önce yakala | |
| `warn-schema-alteration` | ALTER TABLE'ı yürütmeden önce yakala | |
| `warn-large-file-write` | Beklenmedik şekilde büyük dosya yazışlarını yakala | `thresholdKb` |
| `warn-package-publish` | Tesadüfi `npm publish`'i yakala | |
| `warn-background-process` | Istenmeyen arka plan işlemini başlatmayı yakala | |
| `warn-global-package-install` | Istenmeyen global paket kurulumunu yakala | |
| …ve daha fazlası | | |

Tam politika detayları ve parametre referansı: [docs/built-in-policies.mdx](docs/built-in-policies.mdx)

---

## Özel politikalar

Ajanları güvenilir ve odaklı tutmak için kendi politikalarınızı yazın:

```js
import { customPolicies, allow, deny, instruct } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  description: "Üretim yolunu içeren yollara yazmaları engelle",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!["Write", "Edit"].includes(ctx.toolName ?? "")) return allow();
    const path = ctx.toolInput?.file_path ?? "";
    if (path.includes("production")) return deny("Üretim yollarına yazma işlemleri engellenmektedir");
    return allow();
  },
});
```

Aşağıdaki komutla yükleyin:

```bash
failproofai policies --install --custom ./my-policies.js
```

### Karar yardımcıları

| İşlev | Etki |
|----------|--------|
| `allow()` | İşleme izin ver |
| `allow(message)` | İzin ver ve Claude'a bilgilendirici bağlam gönder |
| `deny(message)` | İşlemi engelle; ileti Claude'a gösterilir |
| `instruct(message)` | Claude'un isteme bağlam ekle; engelleme yapma |

### Bağlam nesnesi (`ctx`)

| Alan | Tür | Açıklama |
|-------|------|-------------|
| `eventType` | `string` | `"PreToolUse"`, `"PostToolUse"`, `"Notification"`, `"Stop"` |
| `toolName` | `string` | Çağrılan araç (`"Bash"`, `"Write"`, `"Read"`, …) |
| `toolInput` | `object` | Aracın giriş parametreleri |
| `payload` | `object` | Tam ham olay yükü |
| `session.cwd` | `string` | Claude Code oturumunun çalışma dizini |
| `session.sessionId` | `string` | Oturum tanımlayıcısı |
| `session.transcriptPath` | `string` | Oturum transkripti dosyasının yolu |

Özel hook'lar geçişli yerel içe aktarımları, async/await'i ve `process.env` erişimini destekler. Hatalar açık başarısız olur (günlükleri `~/.failproofai/hook.log` dosyasına yazılır, yerleşik politikalar devam eder). Tam kılavuz için [docs/custom-hooks.mdx](docs/custom-hooks.mdx) dosyasını inceleyebilirsiniz.

### Kural tabanlı politikalar

`*policies.{js,mjs,ts}` dosyalarını `.failproofai/policies/` klasörüne bırakın ve otomatik olarak yüklenir — bayrak veya yapılandırma değişikliğine gerek yok. Klasörü git'e commit edin ve her takım üyesi aynı kalite standartlarını otomatik olarak alır.

```text
# Proje seviyesi — git'e commit edilmiş, takımla paylaşılmış
.failproofai/policies/security-policies.mjs
.failproofai/policies/workflow-policies.mjs

# Kullanıcı seviyesi — kişisel, tüm projeler için geçerli
~/.failproofai/policies/my-policies.mjs
```

Her iki seviye de yüklenir (birleşim). Dosyalar her dizin içinde alfabetik olarak yüklenir. Sırayı kontrol etmek için `01-`, `02-` vb. ile önek ekleyin. Takımınız yeni hata modlarını keşfettikçe, bir politika ekleyin ve gönderin — herkes bir sonraki pull işleminde güncellemeyi alır. Hazır örnekler için [examples/convention-policies/](examples/convention-policies/) dosyasını inceleyebilirsiniz.

---

## Telemetri

Failproof AI, özellik kullanımını anlamak için PostHog aracılığıyla anonim kullanım telemetrisi toplar. Oturum içeriği, dosya adları, araç girdileri veya kişisel bilgiler asla gönderilmez.

Devre dışı bırakmak için:

```bash
FAILPROOFAI_TELEMETRY_DISABLED=1 failproofai
```

---

## Dokümantasyon

| Kılavuz | Açıklama |
|-------|-------------|
| [Başlarken](docs/getting-started.mdx) | Kurulum ve ilk adımlar |
| [Yerleşik Politikalar](docs/built-in-policies.mdx) | Parametreli tüm 39 yerleşik politika |
| [Özel Politikalar](docs/custom-policies.mdx) | Kendi politikalarınızı yazın |
| [Yapılandırma](docs/configuration.mdx) | Yapılandırma dosyası biçimi ve kapsam birleştirme |
| [Pano](docs/dashboard.mdx) | Oturumları izleyin ve politika etkinliğini gözden geçirin |
| [Mimari](docs/architecture.mdx) | Hook sistemi nasıl çalışır |
| [Test Etme](docs/testing.mdx) | Testleri çalıştırın ve yenilerini yazın |

### Dokümanları yerel olarak çalıştırın

```bash
docker build -f Dockerfile.docs -t failproofai-docs .
docker run --rm -p 3000:3000 failproofai-docs
```

`http://localhost:3000` adresinde Mintlify doküman sitesini açar. Konteyner doküman dizinini bağlarsanız değişiklikleri izler:

```bash
docker run --rm -p 3000:3000 -v $(pwd)/docs:/app/docs failproofai-docs
```

---

## failproofai katkıda bulunanlar için not

Bu deponun `.claude/settings.json` dosyası standart `npx -y failproofai` komutu yerine `bun ./bin/failproofai.mjs --hook <EventType>` komutunu kullanır. Bunun nedeni, failproofai projesi içinde `npx -y failproofai` komutunu çalıştırmanın kendi kendine referans veren bir çatışma oluşturmasıdır.

Diğer tüm depolar için önerilen yaklaşım `npx -y failproofai` komutudur ve aşağıdaki komutla yüklenir:

```bash
failproofai policies --install --scope project
```

## Katkıda bulunma

[CONTRIBUTING.md](CONTRIBUTING.md) dosyasını inceleyebilirsiniz.

---

## Lisans

[LICENSE](LICENSE) dosyasını inceleyebilirsiniz.

---

**ExosphereHost: Ajanlarınız için Güvenilirlik Araştırması Laboratuvarı** tarafından oluşturulmuş ve yönetilmektedir. Kuruluşlar ve yeni başlayanların AI ajanlarının güvenilirliğini kendi ajanları, yazılımı ve uzmanlığı aracılığıyla artırmasına yardımcı oluyoruz. Daha fazla bilgi için [exosphere.host](https://exosphere.host) adresini ziyaret edin.
```
