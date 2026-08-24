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

**Aracılarınızın çalıştığı her ortam için gözlenebilirlik ve zorlama.**
Aracılarınız nerede çalışırsa çalışsın, biz görebiliriz — ve hayır diyebiliriz. Failproof, 12 aracı ortamına bağlanır — Claude Code ve Codex gibi kodlama CLI'leri, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendine barındırılan asistanlar — her çalıştırmayı yakalar ve tehlikeli araç çağrılarını yürütülmeden önce engeller. 40 yerleşik ilke. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfta on iki ortam — on kodlama CLI'si ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Aynı olaylar, aynı ilkeler, aynı oturum geçmişi, aracınız hangisinde çalışırsa çalışsın.

Bunlardan hiçbirinde çalışmayan aracılar [Python SDK](https://docs.befailproof.ai/reference/python-sdk) aracılığıyla rapor verir; bu size izleme, oturumlar ve denetim sağlar. Orada zorlama, kendi çalışma zamanınızda bir kancaya ihtiyaç duyar — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve biz bunu eşleştireceğiz.

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

## Yükle

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırın ve ilk çalıştırma istemini kabul edin
failproofai
```

40 yerleşik ilke hemen etkinleşir. Pano `localhost:8020` adresinde. İlk çalıştırma istemini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Neyi engeller

| İlke | Neyi engeller |
|---|---|
| `sanitize-api-keys` | API anahtarlarının aracının bağlamına sızması |
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Aracının aynı çağrıda döngüye girmesi |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırsız `DELETE` |
| `block-terraform` / `block-kubectl` | Gözden geçirilmemiş canlı altyapı değişiklikleri |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main` ağacına doğrudan gönderim |

İlk beş, araç çağırabilen herhangi bir aracı için geçerlidir. Son üç, geliştirici favorileridir — kodlama CLI'leri, en derin kapsama sahip ortam sınıfıdır.

→ [Tüm 40 yerleşik ilke](https://docs.befailproof.ai/policies/builtin)

---

## Kendi ilkeleriniz

`.failproofai/policies/` dosyasına bir dosya bırakın — otomatik olarak yüklenir, hiçbir bayrak gerekmez.
Bunu taahhüt edin ve tüm takım sonraki çekişte bunu alır.

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

Her ilkeye açık olan üç karar vardır:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj aracıya geri dönüşür |
| `instruct(message)` | İzin ver, ancak bağlam aracının sonraki istemiyle ekle |

→ [Özel ilkeler rehberi](https://docs.befailproof.ai/policies/custom)

---

## Gözlenebilirlik

Zorlama bir yarısı. Diğer yarısı, aracının gerçekten ne yaptığını görmektir.

`failproofai` komutunu hiçbir argüman olmadan çalıştırın ve `localhost:8020` adresinde makinenizde zaten bulunan çalıştırma geçmişini okuyan bir pano sunar — hesap yok, kaydolma yok, kutu dışına hiçbir şey çıkmaz. Oturum listesini, her çalıştırma içindeki model çağrılarının sırasını, araç çağrılarını ve kanca kararlarını, engellenenleri ve ilkenin aracıya söylediklerini, ve risky desenler için geçmişinizi tarayacak ve onları durdurmak için ilkeler önerecek çevrimdışı bir denetimi (`failproofai audit`) alırsınız.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İzleme oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlenebilirlik**, aynı veri modelinin barındırılan tarafıdır ve bir filo genelinde aracı çalıştıran takımlar içindir: her ortamdan her çalıştırma bir yerde, paralel alt-aracıların kendi şeritlerinde bulunduğu bir yürütme grafiği, modeller, araçlar ve kancalar için p50/p95/p99 gecikme, model başına maliyet ve bağlam penceresinin izlenmesi, hata izleme, kendi izlemenizin üzerinde SQL paylaşılabilir panolarla, kendi hizmetiniz tarafından puanlanan değerlendirmeler, periyodik hataları kanıta dayalı bulgulara dönüştüren planlanan denetimler ve Slack, e-posta veya imzalı webhook'a yönlendirilen uyarılar. Kendi kümenizde kendi kendine barındırma Enterprise planında mevcuttur.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo rezervasyonu yap](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başlayın | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükle, bir ortamı bağla, ilk çalıştırmayı gör |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | Tüm 12'si ve her birinin ne uygulayabileceği |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalıştırmayı takip et: modeller, araçlar, hatalar, gecikme |
| [İzleme oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği sana ne söylüyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturum arasında hata desenlerini bul |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekmez |

| Zorla | |
|---|---|
| [Yerleşik ilkeler](https://docs.befailproof.ai/policies/builtin) | Tüm 40 ilke parametrelerle |
| [Özel ilkeler](https://docs.befailproof.ai/policies/custom) | Kendi ilkelerini yaz |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları ve birleştirme kuralları |

| Kendi aracını enstrüman et | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/python-sdk) | Ortamı olmayan bir aracıdan çalıştırmaları rapor et |
| [İlke SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

[Commons Clause](https://commonsclause.com/) ile MIT — iç ve kişisel kullanım için ücretsiz; failproofai'nin kendisinin ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](../../LICENSE) dosyasına bakın.

---

## Katkıda bulunun

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Yeni ilkeler, uç durumlar ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce derle.** Önce `bun install && bun run build` komutunu çalıştırın. Bu depo, failproofai'nin kendi kancalarını kendisi üzerinde çalıştırır ve `failproofai` içeri aktarımını derlenmiş `dist/` paketine göre çözerler — bir derleme olmadan, `Cannot find package 'failproofai'` kanca hatalarıyla karşılaşırsınız. `src/` değiştirdikten sonra yeniden derleyin. [Repo içi geliştirme kancaları çalışması için önce derleyin](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) dosyasına bakın.

---

Sevgiyle [befailproof.ai](https://befailproof.ai) tarafından SF ve Bengaluru'da yapılmıştır.
