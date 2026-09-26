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

**Aracılarınızın çalıştığı her ortam için gözlemlenebilirlik ve yaptırım.**
Aracılarınız nerede çalışırsa çalışsın, biz onu görüyoruz — ve bunu reddedebiliriz. Failproof, Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendini barındıran asistanlar dahil olmak üzere 12 aracı ortamını birleştirir ve tehlikeli araç çağrılarını yürütülmeden önce engeller. 39 yerleşik politika. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfta on iki ortam — on kodlama CLI'sı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Tüm ortamlar arasında bir politika API'si ve bir oturum geçmişi. Bir politikanın *engelleyebileceği* şey ortama özgüdür: bir araç çağrısını çalışmadan önce durdurmak tüm on iki ortamda doğrulanır, tur sonunda kapılar sekiz ortamda kontrol edilir. [Ortam başına matris](https://docs.befailproof.ai/reference/harnesses#enforcement-capability), her birinin hangi olayları dikkate aldığını listeler.

Bunların hiçbirinde çalışmayan aracılar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla rapor eder, bu da izleme, oturumlar ve denetimler sağlar. Orada yaptırım, kendi çalışma zamanınıza bir hook gerektirir — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve biz bunu eşleştireceğiz.

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

## Yükleme

```sh
npm install -g failproofai
failproofai config                             # aracılarınızı ve daemon'u bağlayın
failproofai policies add FailproofAI/policies  # ne uygulayacağınızı seçin
failproofai                                    # localhost:8020 üzerinde pano
```

Kurulum, hook'ları bağlar ve **hiçbir** politika seçmez — ikinci komut, makinaya koruma ekleyen şeydir ve herhangi bir paket aynı şekilde yazılır
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` önce bir tanesini okur). `failproofai config` komutunu terminal olmadan çalıştırın — CI, bir kapsayıcı, onu çalıştıran bir aracı — ve sormak yerine uygular. Hiç kurulum yapılmamış bir makinede, başka herhangi bir komut önce aynı sihirbazı çalıştırır; bunu `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

Bir paket gelene kadar, uygulamayı yapan tek şey `block-failproofai-commands` olup, bu her zaman açıktır ve kapatılamaz veya duraklatılamaz: uygulamayı duraklatabilecek bir aracı, diğer her politiği kapatabilir.

---

## Ne engeller

| Politika | Ne engeller |
|---|---|
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Aracının aynı çağrıya takılması |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırsız `DELETE` |
| `block-terraform` / `block-kubectl` | Gözden geçirilmemiş canlı altyapı değişiklikleri |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main` üzerine doğrudan itme |

Her biri çağrıyı çalışmadan önce engeller, bu nedenle hepsi on iki ortamda çalışır. İlk dördü herhangi bir araç çağırabilen herhangi bir aracı için geçerlidir; son üçü, geliştirici favorileridir — kodlama CLI'ları, en derinlemesine kapsadığımız ortam sınıfıdır. `sanitize-*` ailesi ayrıdır: bir araç döndükten sonra çalışır, bu nedenle bağlamın dışında tutmak yerine araç çıkışında bir gizli bilgiyi bildirir.

→ [Tüm 39 yerleşik politika](https://docs.befailproof.ai/policies/packs)

---

## Kendi politikalarınız

`.failproofai/policies/` dizinine bir dosya bırakın — otomatik olarak yüklenir, bayrak gerekmez.
Dosyayı kaydedin ve tüm takım sonraki çekme işleminde bunu alır.

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

Her politika için kullanılabilir üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj aracıya geri gider |
| `instruct(message)` | Geçmesine izin ver, ancak aracının sonraki istemine bağlam ekle |

→ [Bir politika yazın](https://docs.befailproof.ai/policies/editor)

---

## Gözlemlenebilirlik

Yaptırım bir yarısıdır. Diğer yarısı aracının gerçekte ne yaptığını görmektir.

`failproofai` komutunu argüman olmadan çalıştırın ve makinanızda zaten bulunan çalışma geçmişini okuyan `localhost:8020` üzerinde bir pano sunar — hesap yok, kayıt yok, kutudan hiçbir şey çıkmaz. Oturum listesini, her çalışma içindeki model çağrıları, araç çağrıları ve hook kararlarının sırasını, engellenen şeyi ve politikanın aracıya söylediklerini ve riskli desenleri için tarihinizi tarayan ve bunları durduracak politikalar önerien çevrimdışı bir denetimi (`failproofai audit`) alırsınız.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İzleme okuyun](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği**, aynı veri modelinin barındırılan tarafıdır, aracıları bir filoette çalıştıran takımlar için: her ortamdan her çalışma bir yerde, paralel alt aracıları kendi şeritleri üzerinde olan bir yürütme grafiği, modeller, araçlar ve hook'lar için p50/p95/p99 gecikme, model başına maliyet ve bağlam penceresi izleme, hata izleme, kendi izlemeleri üzerinde paylaşılabilir panolar ile SQL, kendi hizmetiniz tarafından puanlanan değerlendirmeler, yinelenen arızaları kanıta dayanan bulgulara dönüştüren zamanlanmış denetimler ve Slack, e-posta veya imzalı bir web kancasına yönlendirilen uyarılar. Kendi kümenizde kendi barındırma, Kurumsal plan üzerinde kullanılabilir.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo kitabı](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başlangıç | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükleyin, bir ortamı bağlayın, ilk çalışmayı görün |
| [Konseptler](https://docs.befailproof.ai/start/concepts) | Hook sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | Hepsi 12 ve her birinin ne uygulayabileceği |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalışmayı takip edin: modeller, araçlar, hatalar, gecikme |
| [İzleme okuyun](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği size ne söylüyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturum arasında hata desenleri bulun |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekmez |

| Uygula | |
|---|---|
| [Politika paketleri](https://docs.befailproof.ai/policies/packs) | Failproof AI politikaları ve politika hub'ından paketler |
| [Bir politika yazın](https://docs.befailproof.ai/policies/editor) | Bir denetimden veya kodda |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları, birleştirme kuralları ve politika parametreleri |

| Kendi aracınızı enstrüman edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Ortamı olmayan bir aracıdan çalışmaları rapor edin |
| [Politika SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` başvurusu |

---

## Lisans

[Commons Clause](https://commonsclause.com/) ile MIT — dahili ve kişisel kullanım için ücretsiz; failproofai'nin kendisinin ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LİSANS](../../LICENSE) bölümüne bakın.

---

## Katkı

[CONTRIBUTING.md](../../CONTRIBUTING.md) bölümüne bakın. Yeni politikalar, uç durumlar ve çeviriler hoş geldiniz.

> **Başlamadan önce derleyin.** Önce `bun install && bun run build` komutunu çalıştırın. Bu depo, failproofai'nin kendi hook'larını kendisinde çalıştırır ve bunlar `failproofai` içeri aktarmasını derlenmiş `dist/` paketine karşı çözerler — derleme olmadan `Cannot find package 'failproofai'` hook hataları alırsınız. `src/` değiştirdikten sonra yeniden derleyin. Bkz.
> [İçeri aktarılan geliştirme hook'ları çalışacak şekilde derleyin](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

❤️ ile [befailproof.ai](https://befailproof.ai) tarafından SF ve Bengaluru'da yapılmıştır.
