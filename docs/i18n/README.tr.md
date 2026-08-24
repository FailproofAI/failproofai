> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

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

**Çeviriler:** [简体中文](../../docs/i18n/README.zh.md) · [日本語](../../docs/i18n/README.ja.md) · [한국어](../../docs/i18n/README.ko.md) · [Español](../../docs/i18n/README.es.md) · [Português](../../docs/i18n/README.pt-br.md) · [Deutsch](../../docs/i18n/README.de.md) · [Français](../../docs/i18n/README.fr.md) · [Русский](../../docs/i18n/README.ru.md) · [हिन्दी](../../docs/i18n/README.hi.md) · [Türkçe](../../docs/i18n/README.tr.md) · [Tiếng Việt](../../docs/i18n/README.vi.md) · [Italiano](../../docs/i18n/README.it.md) · [العربية](../../docs/i18n/README.ar.md) · [עברית](../../docs/i18n/README.he.md)

**Ajanların çalıştığı her ortamda gözlemlenebilirlik ve uygulama.**
Ajanların nerede çalıştığını görebiliriz — ve hayır diyebiliriz. Failproof, Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendine barındırılan asistanlar olmak üzere 12 ajan ortamını kancalamakta, her çalışmayı yakalamakta ve tehlikeli araç çağrılarını yürütülmeden önce engellemektedir. 40 yerleşik politika. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfta on iki ortam — on kodlama CLI'sı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Aynı olaylar, aynı politikalar, aynı oturum geçmişi, ajan hangi ortamda çalışırsa çalışsın.

Bunların hiçbirinde çalışmayan Ajanlar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla rapor verir; bu size izleme, oturumlar ve denetim yeteneği sağlar. Orada uygulama, kendi çalışma ortamınızda bir kanca gerektirir — [bize yazın](mailto:support@befailproof.ai) ve biz bunu eşleştireceğiz.

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

## Kurulum

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırın ve ilk çalıştırma istemini kabul edin
failproofai
```

40 yerleşik politika hemen etkinleştirilir. Pano şu adreste bulunur: `localhost:8020`. İlk çalıştırma istemini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Neleri engeller

| Politika | Neyi engeller |
|---|---|
| `sanitize-api-keys` | API anahtarlarının ajanın bağlamına sızması |
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Ajanın aynı çağrıda döngüye girmesi |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırsız `DELETE` |
| `block-terraform` / `block-kubectl` | Canlı altyapıya incelenmemiş değişiklikler |
| `block-rm-rf` | Yinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main` öğesine doğrudan push işlemleri |

İlk beş tanesinin herhangi bir araç çağırabilen ajan için geçerlidir. Son üçü geliştirici favori notları — kodlama CLI'ları, en derinlemesine kapsadığımız ortam sınıfıdır.

→ [40 yerleşik politikanın tümü](https://docs.befailproof.ai/policies/builtin)

---

## Kendi politikalarınız

`.failproofai/policies/` klasörüne bir dosya bırakın — bayrak gerekli olmaksızın otomatik olarak yüklenir.
İşleyin ve tüm takım bunu sonraki pull'da alır.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Production yollarına yazma işlemleri engellenir.");
    return allow();
  },
});
```

Her politika için kullanılabilir üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — ileti ajana geri gider |
| `instruct(message)` | Bunu geçir, ancak ajanın sonraki istemine bağlam ekle |

→ [Özel politikalar rehberi](https://docs.befailproof.ai/policies/custom)

---

## Gözlemlenebilirlik

Uygulama bir yarısı. Diğer yarısı ise ajanın gerçekte ne yaptığını görmektir.

`failproofai` parametresiz çalıştırın ve makinenizde zaten bulunan çalışma geçmişini okuyan `localhost:8020` adresinde bir pano sunar — hesap yok, kayıt yok, hiçbir şey kutudan dışarı çıkmaz. Oturum listesini, model çağrılarının sırasını, her çalışma içindeki araç çağrılarını ve kanca kararlarını, neyin engellendiğini ve politikanın ajana söylediklerini, ve risky desenleri için çalışma geçmişinizi taraması yapan ve onları durdurmak için politikalar önerenin çevrimdışı denetimini (`failproofai audit`) alırsınız.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İz oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği**, bir filo arasında ajanlar çalıştıran takımlar için aynı veri modelinin barındırılan tarafıdır: her ortamdan her çalışma tek bir yerde, kendi şeritlerinde paralel alt-ajanlar içeren bir yürütme grafiği, modeller, araçlar ve kancalar için p50/p95/p99 gecikmesi, model başına maliyet ve bağlam penceresi izlemesi, hata izlemesi, kendi izlemeleri üzerinden SQL paylaşılabilir panolarla, kendi hizmetiniz tarafından puanlandırılan değerlendirmeler, yinelenen hataları kanıta dayalı bulgulara dönüştüren planlanan denetimler ve Slack, e-posta veya imzalı webhooks'a yönlendirilen uyarılar. Kendi kümenizde kendi kendine barındırma, Enterprise planında kullanılabilir.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo ayırtın](https://befailproof.ai/get-a-demo)

---

## Belgeleme

| Başlangıç | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Kurulum yapın, bir ortamı bağlayın, ilk çalışmayı görün |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | Tümü 12 ve her birinin uygulayabileceği |

| Gözlemleyin | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalışmayı izleyin: modeller, araçlar, hatalar, gecikme |
| [İz oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği size ne anlatıyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturumdaki başarısızlık desenleri bulun |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekli değil |

| Uygulayın | |
|---|---|
| [Yerleşik politikalar](https://docs.befailproof.ai/policies/builtin) | Tüm 40 politika parametrelerle |
| [Özel politikalar](https://docs.befailproof.ai/policies/custom) | Kendinizinkini yazın |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları ve birleştirme kuralları |

| Kendi ajanınızı enstrüman edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Ortamı olmayan bir ajanın çalışmalarını raporlayın |
| [Politika SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` başvurusu |

---

## Lisans

MIT ile [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'nin kendisinin ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](../../LICENSE) dosyasına bakın.

---

## Katkı

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, kenar durumları ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce derleyin.** Önce `bun install && bun run build` çalıştırın. Bu depo failproofai'nin kendi kancalarını kendisinde çalıştırır ve bunlar `failproofai` ithalatını derlenmiş `dist/` paketine karşı çözer — derleme olmadan `Cannot find package 'failproofai'` kanca hatalarına çarparsınız. `src/` dosyalarını değiştirdikten sonra yeniden derleyin. Bkz. [In-repo dev kankaları çalışacak şekilde Derle](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

San Francisco ve Bengaluru'da [befailproof.ai](https://befailproof.ai) tarafından ❤️ ile yapılmıştır.
