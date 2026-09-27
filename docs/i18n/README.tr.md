> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Çeviriler:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Ajanlarınızın çalıştığı her ortam için gözlemlenebilirlik ve uygulama.**
Ajanlarınız nerede çalışırsa çalışsın, biz bunu görebiliyoruz — ve hayır diyebiliyoruz. Failproof AI, 12 ajan ortamına bağlanıyor — Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendini barındıran asistanlar — her çalıştırmayı yakalayarak ve tehlikeli araç çağrılarını yürütülmeden önce engelleyerek. 40 yerleşik politika. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI çalışırken" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfta on iki ortam — on kodlama CLI'sı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Hepsi için bir politika API'si ve bir oturum geçmişi. Bir politikanın engelle *bildirimi* ortama özel: araç çağrısını çalışmadan önce durdurmak on iki ortamda da doğrulanıyor, tur sonu kapıları sekizde açılıyor. [Ortama özel matris](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) her birinin hangi olayları onayladığını listeler.

Bunların hiçbirinde çalışmayan ajanlar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla rapor verir, bu da size izleme, oturumlar ve denetim sağlar. Orada uygulama, kendi çalışma zamanınızda bir hook'a ihtiyaç duyar — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve bunu eşleştiririz.

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

## Yüklü

```sh
npm install -g failproofai
failproofai config                             # ajanlarınızı ve daemon'u bağlayın
failproofai policies add FailproofAI/policies  # uygulamak istediğinizi seçin
failproofai                                    # localhost:8020'de pano
```

Kurulum hook'ları bağlar ve **hiçbir** politika seçmez — bu ikinci komut makinaya koruma bariyeri koyan şeydir ve herhangi bir paket aynı şekilde yazılmıştır (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` birini önce okur). `failproofai config` komutunu terminalsiz çalıştırın — CI, kapsayıcı, onu çalıştıran bir ajan — ve sormak yerine uygular. Hiç kurulumu olmayan bir makinede, başka herhangi bir komut ilk önce aynı sihirbazı çalıştırır; `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

Bir paket gelene kadar, uygulama yapan tek şey `block-failproofai-commands`'dir; bu her zaman açıktır ve kapatılamaz veya duraklatılamaz: uygulamayı duraklatabilecek bir ajan, başka her politiği kapatabilir.

---

## Neleri engeller

| Politika | Neleri engeller |
|---|---|
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Ajanın aynı çağrı üzerinde döngü yapması |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırsız `DELETE` |
| `block-terraform` / `block-kubectl` | İncelenmemiş canlı altyapı değişiklikleri |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main`'e doğrudan itmeler |

Bunların her biri, çalışmadan önce çağrıyı kontrol eder, bu nedenle tüm on iki ortamda tutarlar. İlk dördü, araç çağırabilen herhangi bir ajan için geçerlidir; sonuncusu üçü geliştirici favorileridir — kodlama CLI'ları, derinlemesine kapsadığımız ortam sınıfıdır. `sanitize-*` ailesi ayrıdır: bir araç döndükten sonra çalışır, bu nedenle bağlam dışında tutmak yerine araç çıktısında bir gizli veri bildirir.

→ [Tüm 40 yerleşik politika](https://docs.befailproof.ai/policies/packs)

---

## Kendi politikalarınız

`.failproofai/policies/` içine bir dosya bırakın — otomatik olarak yüklenir, hiçbir bayrak gerekli değil.
Bunu işleyin ve tüm takım bir sonraki pull'da alır.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Üretim yollarına yazma işlemleri engellenir.");
    return allow();
  },
});
```

Her politika için üç karar mevcuttur:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj ajana geri döner |
| `instruct(message)` | İzin ver, ancak ajana bir sonraki isteminde bağlam ekle |

→ [Politika yazma](https://docs.befailproof.ai/policies/editor)

---

## Gözlemlenebilirlik

Uygulama bir yarısı. Diğer yarısı ajanın gerçekte ne yaptığını görmektir.

`failproofai` komutunu hiçbir argümansız çalıştırın ve `localhost:8020`'de makinenizde zaten var olan çalıştırma geçmişini okuyan bir pano sunar — hesap yok, kayıt yok, hiçbir şey kutunun dışına çıkmaz. Oturum listesini, her çalıştırma içindeki model çağrıları, araç çağrıları ve hook kararlarının sırasını, neyin engellediğini ve politikanın ajana ne söylediğini, ve risky desenleri taramak için çevrimdışı denetim (`failproofai audit`) alırsınız ve politikalar önerebilir.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İz okuma](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği**, aynı veri modelinin barındırılan tarafı, bir filo genelinde ajanlar çalıştıran takımlar için: her ortamdaki her çalıştırma bir yerde, kendi şeritlerinde paralel alt-ajanlarla yürütme grafiği, modeller, araçlar ve hook'lar için p50/p95/p99 gecikme, model başına maliyet ve bağlam penceresi izleme, hata izleme, izlemeleriniz üzerinde SQL ve paylaşılabilir panolar, kendi hizmetiniz tarafından puanlanmış değerlendirmeler, yinelenen başarısızlıkları kanıt destekli bulgulara dönüştüren zamanlanmış denetimler, ve Slack, e-posta veya imzalı webhook'a yönlendirilen uyarılar. Enterprise planında kendi kümenizde kendi kendini barındırma mevcuttur.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Tanıtım kitabı](https://befailproof.ai/get-a-demo)

---

## Dokümantasyon

| Başlangıç | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükleyin, bir ortamı bağlayın, ilk çalıştırmayı görün |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Hook sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | Tümü 12, ve her biri hangi uygulamayı yapabilir |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalıştırmayı takip edin: modeller, araçlar, hatalar, gecikme |
| [İz okuma](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği sana ne söylüyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturum genelinde hata desenleri bulun |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekli değil |

| Uygula | |
|---|---|
| [Politika paketleri](https://docs.befailproof.ai/policies/packs) | Failproof AI politikaları ve politika hub'ından paketler |
| [Politika yazma](https://docs.befailproof.ai/policies/editor) | Denetimden veya kodda |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Config kapsamları, birleştirme kuralları ve politika parametreleri |

| Kendi ajanınızı enstrümente edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Ortamı olmayan bir ajandan çalıştırmaları raporlayın |
| [Politika SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

MIT ve [Commons Clause](https://commonsclause.com/) ile — dahili ve kişisel kullanım için ücretsiz; failproofai'in kendisinin ticari olarak yeniden satılması ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](../../LICENSE) bölümüne bakın.

---

## Katkı sağlama

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, kenar durumlar ve çeviriler hepsi hoş karşılanır.

> **Başlamadan önce derleyin.** İlk olarak `bun install && bun run build` komutunu çalıştırın. Bu depo, failproofai'in kendi hook'larını kendisinde çalıştırır ve derlenmiş `dist/` paketine karşı `failproofai` içe aktarımını çözer — derleme olmadan `Cannot find package 'failproofai'` hook hatalarına çarparsınız. `src/` değiştirdikten sonra yeniden derleyin. [Hook'ların depo içi geliştirme çalışacağı zaman derleyin](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

❤️ ile [befailproof.ai](https://befailproof.ai) tarafından SF ve Bengaluru'da yapılmış.
