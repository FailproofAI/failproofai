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

**Aracılarınızın ne yaptığını görün. Bilinen hatalarının tekrar etmesini önleyin.**
Failproof AI, aracılarınızın çalıştığı her yerde çalışır: Claude Code ve
Codex gibi kodlama araçları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi
kendi kendine barındırılan asistanlar ve kendiniz araç tarafından donatılan aracılar.
Her çalışmayı kaydeder ve tehlikeli araç çağrılarını yürütülmeden önce engelleyebilir.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen harnisler

İki sınıfta on iki harnis desteklenir: on kodlama CLI'si, artı iki ağ geçidi: Hermes, OpenClaw. İlke API'si ve oturum geçmişi paylaşılır; hangi olayların engelleneceği harnise göre değişir.

Bunların hiçbirinde çalışmayan aracılar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla rapor verir;
bu, size izleme, oturumlar ve denetimler sağlar. Uygulamada bir engelin kendi çalışma zamanınızda bir kanca gerekir — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve biz bunu haritalandıracağız.

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

Uyumlu bir aracıya Failproof AI becerisi vermek istiyorsanız, kurulumu yönlendirmesi, makineyi incelemesi ve ilke, denetim, oturum ve Bulut çalışmalarını doğru şekilde yönlendirmesi için:

```sh
npx skills add FailproofAI/skills
```

Bu şemsiye beceriyi ve uzman kardeşlerini yükler. Yalnızca şemsiyeyi yüklemek için `--skill failproofai` ekleyin. Beceriler işletim talimatları sağlar; ürünü kendisini yükleyin ve yapılandırın:

```sh
npm install -g failproofai
failproofai config
failproofai policies add FailproofAI/policies
failproofai                         # dashboard on localhost:8020
```

Kurulum, desteklenen aracıları bağlar ve arka plan hizmetini yükler. Hiçbir ilke paketi seçmez: bir tane eklemeden önce, yalnızca `block-failproofai-commands` bir aracının Failproof AI'yi devre dışı bırakmasını önlemek için çalışır.

Bulut'u istemler olmadan `failproofai config --token <machine-key>` ile bağlayın. Paylaşılan bir makinede veya CI'de, `FAILPROOFAI_CLOUD_TOKEN` ayarlayın ve `failproofai config` çalıştırın, böylece anahtar komut geçmişinde görünmez.

---

## Neyi engeller

| İlke | Neyi engeller |
|---|---|
| `sanitize-api-keys` | API anahtarlarının aracının bağlamına sızması |
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Aracı aynı çağrıyı tekrar ettiğinde döngüye girme |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırlandırılmamış `DELETE` |
| `block-terraform` / `block-kubectl` | Canlı altyapıda incelenmemiş değişiklikler |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main` adresine doğrudan itme |

Bu ilkeler dosyaları, kimlik bilgilerini, altyapıyı, veritabanlarını ve aracı iş akışlarını korur. Tam uygulamada destek harnise ve olaya göre değişir.

→ [Tüm 39 yerleşik ilke](https://docs.befailproof.ai/policies/builtin)

---

## Kendi ilkeleriniz

`.failproofai/policies/` klasörüne bir dosya bırakın — otomatik olarak yüklenir, bayrak gerekmez.
Bunu taahhüt edin ve tüm takım sonraki çekmede alacak.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Üretim yollarına yazma engellenir.");
    return allow();
  },
});
```

Her ilke için üç karar mevcuttur:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — ileti aracıya geri döner |
| `instruct(message)` | Bırak, ancak aracının sonraki istemiyle bağlam ekle |

→ [Özel ilkeler rehberi](https://docs.befailproof.ai/policies/custom)

---

## İlke paketleri

İlke paketi, genel bir GitHub deposundan yayınlanan sürüm kontrollü bir ilkeler kümesidir. Yüklemeden önce bir tanesini inceleyin:

```sh
failproofai policies show FailproofAI/policies
failproofai policies add FailproofAI/policies
```

Eğik çizgi olanlar paket kaynağıdır; olmayanlar ilke adıdır.
Seçilen kategorileri veya ilkeleri yükleyebilir ve gerektiğinde bir sürümü sabitleyebilirsiniz.

```sh
failproofai policies add FailproofAI/policies --category git,database
failproofai policies add owner/repo@a1b2c3d4e5f6
```

[İlke Hub'da](https://befailproof.ai/policy-hub/) yayınlanmış paketleri tarayın veya
kendi oluşturmaya başlamak için `failproofai publish --init` çalıştırın. Gözlem modu, bir paketin engellemeden ne yapacağını kaydetmesini sağlar: `failproofai publish --effect observe`.

→ [İlke paketleri](https://docs.befailproof.ai/policies/packs) ·
[Bir paket yayınla](https://docs.befailproof.ai/policies/publish-a-pack)

---

## Gözlemlenebilirlik

Uygulamada bir yarısıdır. Diğer yarısı aracının gerçekte ne yaptığını görmektir.

`failproofai` hiçbir argümansız çalıştırın ve makinenizde zaten bulunan çalışma geçmişini okuyan `localhost:8020` adresinde bir pano sunar — hesap yok, kaydolma yok, kutudan hiçbir şey ayrılmaz. Oturum listesini, her çalışmada model çağrılarının, araç çağrılarının ve kanca kararlarının sırasını, engellenenler ve ilkenin aracıya söylediklerini ve tehlikeli kalıplar için geçmişinizi tarayan çevrimdışı bir denetimi (`failproofai audit`) ve onları durdurmak için ilkeleri öner.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İzleme oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirlik**, aynı veri modelinin barındırılan tarafıdır, bir filodan çalıştıran takımlar için: bir yerden her harnisten her çalışma, paralel alt aracılara kendi şeritlerinde bir yürütme grafiği, p50/p95/p99 gecikme modeller, araçlar ve kancalar için model başına maliyet ve bağlam penceresinde izleme, hata izleme, izlemeleriniz üzerinde SQL paylaşılabilir panolarla, kendi hizmetiniz tarafından puanlandırılan değerlendirmeler, tekrarlayan hatalarını kanıta dayalı bulgulara dönüştüren zamanlanmış denetimler ve Slack, e-posta veya imzalı webhook'a yönlendirilen uyarılar. Kendi kümesinde kendi kendine barındırma Enterprise planında mevcuttur.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo ayırt et](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başlangıç | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükle, bir harnis bağla, ilk çalışmayı gör |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen harnisler](https://docs.befailproof.ai/reference/harnesses) | Tümü 12, ve her biri neyi uygulayabilir |

| Gözlemleme | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalışmayı takip et: modeller, araçlar, hatalar, gecikme |
| [İzleme oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği sana ne söylüyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturumda hata kalıplarını bul |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekmez |

| Uygula | |
|---|---|
| [Yerleşik ilkeler](https://docs.befailproof.ai/policies/builtin) | Tüm 39 ilke parametreleriyle |
| [Özel ilkeler](https://docs.befailproof.ai/policies/custom) | Kendi oluştur |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları ve birleştirme kuralları |

| Kendi aracınızı araç tutun | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Harnisi olmayan bir aracıdan çalışmaları rapor et |
| [İlke SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

[Commons Clause](https://commonsclause.com/) ile MIT — iç ve kişisel kullanım için ücretsiz; failproofai'nin ticari satışı ayrı bir anlaşma gerektirir. Tam metin için [LİSANS](../../LICENSE) bölümüne bakın.

---

## Katkıda bulunma

Bkz. [CONTRIBUTING.md](../../CONTRIBUTING.md). Yeni ilkeler, sınır durumları ve çeviriler hoş geldiniz.

> **Başlamadan önce oluştur.** İlk olarak `bun install && bun run build` komutunu çalıştırın. Bu repo failproofai'nin kendi kancalarını kendisi üzerinde çalıştırır ve `failproofai` içeri aktarımını derlenmiş `dist/` paketine karşı çözer — bir yapı olmadan `Cannot find package 'failproofai'` kanca hatalarına çarptacaksınız. `src/` değiştirdikten sonra yeniden oluştur. Bkz.
> [İçi repo geliştirme kancaları çalışmadan önce oluştur](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

SF ve Bengaluru'da [befailproof.ai](https://befailproof.ai) tarafından ❤️ ile inşa edilmiştir.
