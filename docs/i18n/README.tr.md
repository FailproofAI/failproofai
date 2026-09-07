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

**Agenlarınızın çalıştığı her sistem için gözlemlenebilirlik ve zorlama.**
Agenlarınız nereye çalışırsa çalışsın, biz bunu görüyoruz — ve hayır diyebiliriz. Failproof, 12 ajan sistemine kanca yerleştiriyor — Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendini barındıran asistanlar — her çalıştırmayı yakalayıp tehlikeli araç çağrılarını yürütülmeden önce engelleme. 39 yerleşik politika. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen sistemler

İki sınıfta on iki sistem — on kodlama CLI'sı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Aynı olaylar, aynı politikalar, aynı oturum geçmişi, agenınız hangisinde çalışırsa çalışsın.

Bunlardan hiçbirinde çalışmayan ajanlar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) üzerinden rapor verin,
bu size izleme, oturumlar ve denetimler sunar. Orada zorlama, kendi çalışma zamanınıza bir kanca gerektirir — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve biz bunu haritalandıracağız.

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

39 yerleşik politika hemen etkinleşir. Pano `localhost:8020` adresinde bulunur. İlk çalıştırma istemini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Engellediği şeyler

| Politika | Engellediği şey |
|---|---|
| `sanitize-api-keys` | API anahtarlarının ajanın bağlamına sızması |
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Ajanın aynı çağrıda döngü halinde kalması |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırlandırılmamış `DELETE` |
| `block-terraform` / `block-kubectl` | Canlı altyapıya gözden geçirilmemiş değişiklikler |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, doğrudan `main` dalına gönderimler |

İlk beş, bir araç çağırabilen herhangi bir ajana uygulanır. Son üç, geliştirici favorileridir — kodlama CLI'ları, en derinlemesine kapsadığımız sistem sınıfıdır.

→ [Tüm 39 yerleşik politika](https://docs.befailproof.ai/policies/builtin)

---

## Kendi politikalarınız

Bir dosyayı `.failproofai/policies/` içine bırakın — otomatik olarak yüklendiğinde, hiçbir bayrak gerekmez.
Bunu kaydedin ve tüm ekip sonraki çekme işleminde bunu alacak.

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

Her politika için üç karar mevcuttur:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj ajana geri gider |
| `instruct(message)` | İzin ver, ama ajanın sonraki istemine bağlam ekle |

→ [Özel politikalar rehberi](https://docs.befailproof.ai/policies/custom)

---

## Gözlemlenebilirlik

Zorlama bir yarısı. Diğer yarısı ajanın aslında ne yaptığını görmektir.

Hiçbir argüman olmadan `failproofai` çalıştırın ve makinenizde zaten olan çalıştırma geçmişini okuyan `localhost:8020` adresinde bir pano sunacaktır — hesap yok, kaydolma yok, kutudan hiçbir şey çıkmıyor. Oturum listesini, her çalıştırma içinde model çağrılarının, araç çağrılarının ve kanca kararlarının sırasını, engellenenin ne olduğunu ve politikanın ajana ne söylediğini ve geçmişinizi riskli desenler açısından tarayan ve onları durduracak politikaları öneren çevrimdışı bir denetimi (`failproofai audit`) alırsınız.

→ [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) ·
[İzlemeyi oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği**, aynı veri modelinin barındırılan tarafı, bir filo genelinde ajanlar çalıştıran takımlar için: her sistemden her çalıştırma tek bir yerde, kendi şeritlerinde paralel alt ajanlarla bir yürütme grafiği, modeller, araçlar ve kancalar için p50/p95/p99 gecikme, model başına maliyet ve bağlam penceresi izleme, hata izleme, kendi izlemeleriniz üzerinde SQL ve paylaşılabilir panolar, kendi hizmetiniz tarafından puanlanan değerlendirmeler, yinelenen hataları kanıt destekli bulgulara dönüştüren planlanan denetimler ve Slack, e-posta veya imzalı webhook'a yönlendirilen uyarılar. Kendi kümenizde kendi barındırma Enterprise planında kullanılabilir.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo ayırtın](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başlangıç | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükleyin, bir sistem bağlayın, ilk çalıştırmayı görün |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen sistemler](https://docs.befailproof.ai/reference/harnesses) | Tümü 12 ve her biri ne uygulayabileceği |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalıştırmayı izleyin: modeller, araçlar, hatalar, gecikme |
| [İzlemeyi oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiğinin size söyledikleri |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Çok sayıda oturum genelinde hata desenlerini bulun |
| [Yerel pano](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekmez |

| Zorlama | |
|---|---|
| [Yerleşik politikalar](https://docs.befailproof.ai/policies/builtin) | Tüm 39 politika parametrelerle |
| [Özel politikalar](https://docs.befailproof.ai/policies/custom) | Kendinizinkini yazın |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları ve birleştirme kuralları |

| Kendi ajanınızı enstrüman edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Sistem olmayan ajanından çalıştırmaları rapor edin |
| [Politika SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

MIT with [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'nin ticari olarak yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](../../LICENSE) bölümüne bakın.

---

## Katkıda bulunma

[CONTRIBUTING.md](../../CONTRIBUTING.md) bölümüne bakın. Yeni politikalar, kenar durumlar ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce derleyin.** İlk olarak `bun install && bun run build` komutunu çalıştırın. Bu depo, failproofai'nin kendi kancalarını kendinde çalıştırır ve `failproofai` içe aktarımını derlenmiş `dist/` paketine karşı çözerler — bir yapı olmadan `Cannot find package 'failproofai'` kanca hataları alırsınız. `src/` değiştikten sonra yeniden derleyin. Bkz.
> [İn-repo dev hooks'un çalışması için önce derleyin](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

SF ve Bengaluru'da [befailproof.ai](https://befailproof.ai) tarafından ❤️ ile yapıldı.
