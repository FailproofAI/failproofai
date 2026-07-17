> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Çeviriler:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Kodlama ajanları için çalışma zamanı hata çözümü.**
Claude Code ve Codex ile entegre çalışır. Döngüleri, tehlikeli eylemleri ve gizli demiş olsa da başında yakalar
onlar olay haline gelmeden. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen ajan CLI'ları

{/* A 6-column table instead of inline <img> runs: table columns never re-wrap,
     so the grid stays 2×6 at any window width (scrolling on very narrow screens
     instead of collapsing into ragged orphan rows). */}
<table align="center">
  <tr>
    <td align="center" width="96">
      <a href="https://claude.com/claude-code" title="Claude Code">
        <img src="assets/logos/claude.svg" alt="Claude Code" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://learn.chatgpt.com" title="OpenAI Codex">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
          <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
          <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://cursor.com" title="Cursor Agent CLI">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
          <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://opencode.ai/" title="OpenCode">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
          <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
          <img src="assets/logos/pi-light.svg" alt="Pi" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="96">
      <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
          <img src="assets/logos/hermes-light.svg" alt="Hermes" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
        <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://factory.ai/" title="Factory Droid (droid)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
          <img src="assets/logos/factory-light.png" alt="Factory Droid" width="56" height="56" />
        </picture>
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://devin.ai" title="Devin CLI (Cognition)">
        <img src="assets/logos/devin.svg" alt="Devin CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://antigravity.google" title="Antigravity CLI (agy)">
        <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="56" height="56" />
      </a>
    </td>
    <td align="center" width="96">
      <a href="https://goose-docs.ai/" title="Goose (codename goose)">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
          <img src="assets/logos/goose-light.svg" alt="Goose" width="56" height="56" />
        </picture>
      </a>
    </td>
  </tr>
</table>

> Bir veya birden fazla için hook'ları yükleyin: `failproofai policies --install --cli opencode pi` (veya `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Kurulu CLI'ları otomatik olarak algılamak ve seçmek için `--cli` seçeneğini atlayın.
>
> **Hermes** (hermes-agent, bir Slack/Telegram ağ geçidi), hem **canlı-hook zorlama** (`--cli hermes` — bir kurulum her platformdan ve alt ajantan gelen araç çağrılarını keser) hem de çevrimdışı **denetim** oturum tekrarı için desteklenir.
>
> **OpenClaw** (openclaw ağ geçidi, kendi kendine barındırılan çok kanallı bir asistan), hem **canlı-hook zorlama** (`--cli openclaw`, kullanıcı kapsamı) hem de çevrimdışı **denetim** tekrarı için desteklenir. Zorlama, OpenClaw'ın **işlem içi eklenti hook'larını** kullanır (gönderilen `openclaw-plugin/`, failproofai'yi zaman uyumsuz olarak başlatır — dosya tabanlı iç hook'ları gözlemsel niteliktedir ve engel kuramazlar): `before_tool_call` bir aracı engeller ve `before_agent_finalize` gerçek bir sıra sonu kapısıdır.
>
> **Factory Droid** (`droid`), hem **canlı-hook zorlama** (`--cli factory`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** tekrarı için desteklenir. droid, hook çıkış kodu 2'si (bir JSON kararı değil) kapalı araç çağrılarını engeller ve `{decision:"block"}`'i yalnızca sıra sonu `Stop` olayında kabul eder.
>
> **Devin CLI** (`devin`, Cognition), hem **canlı-hook zorlama** (`--cli devin`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** tekrarı için desteklenir. Devin, **saf Claude klonu** — aynı olay adları, aynı snake_case yükü, aynı `hooks` sarıcı yapılandırması.
>
> **Antigravity CLI** (`agy`), hem **canlı-hook zorlama** (`--cli antigravity`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** tekrarı için desteklenir. Antigravity'nin **kendi** sözleşmesi vardır (Claude klonu değil): `hooks.json` şeması, failproofai'nin normalleştirdiği camelCase stdin yükü ve kendi yanıt şekilleri — araç çağrısını engellemek için `{decision:"deny"}`, sıra sonunda başka bir dönüş zorlamak için `{decision:"continue"}`, model çalıştırılmadan önce hatırlatma enjekte etmek için `{injectSteps}`.
>
> **Goose** (goose kodu adı, Block), hem **canlı-hook zorlama** (`--cli goose`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** tekrarı için desteklenir. Zorlama, Goose'un **hook'lar** sistemini kullanır (çapraz ajan **Open Plugins** spesifikasyonu) — yükleyici sadece bir eklenti dizinini `~/.agents/plugins/failproofai/` adresine yerleştirir ve Goose onu otomatik olarak bulur. Engelleme, `PreToolUse` olayında `{"decision":"block"}` JSON'dur (kabuk aracı ve delege edilmiş alt ajanlar içinde çalışır); Goose'un sıra sonu `Stop` olayı yoktur, bu nedenle `require-*-before-stop` yerleşikleri geçerli değildir.

---

## Kurulum

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırın ve ilk çalışma istemini kabul edin
failproofai
```

30 yerleşik politika hemen etkinleşir. Pano `localhost:8020` adresinde yer alır. İlk çalışma istemini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Neleri engeller

| Politika | Neleri engeller |
|---|---|
| `block-push-master` | `main` / `master` öğesine doğrudan push |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` üzerinde commit, merge, rebase |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `sanitize-api-keys` | API anahtarlarının ajan bağlamına sızması |

→ [Tüm 30 yerleşik politika](https://docs.befailproof.ai/built-in-policies)

---

## Kendi politikalarınız

`.failproofai/policies/` klasörüne bir dosya bırakın — hiçbir bayrak gerekmeden otomatik olarak yüklenir.
Bunu commitleyin ve tüm takım sonraki pull'da bunu alır.

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

Her politika için kullanılabilir üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj ajana geri gider |
| `instruct(message)` | Geçmesine izin ver ama ajanın sonraki istemini bağlama ekle |

→ [Özel politikalar kılavuzu](https://docs.befailproof.ai/custom-policies)

---

## Oturum görünürlüğü

Ajanınızın yaptığı her araç çağrısı yerel olarak günlüğe kaydedilir. Pano, neyin çalıştırıldığını,
engellenenin ne olduğunu ve politikanın ajana ne söylediğini gösterir — bu nedenle
bir şey yanlış gittiğinde tahmin etmeniz gerekmez. → [Pano kılavuzu](https://docs.befailproof.ai/dashboard)

---

## Belgeler

| | |
|---|---|
| [Başlarken](https://docs.befailproof.ai/getting-started) | Kurulum ve ilk adımlar |
| [Yerleşik Politikalar](https://docs.befailproof.ai/built-in-policies) | Tüm 30 politika ve parametreleri |
| [Özel Politikalar](https://docs.befailproof.ai/custom-policies) | Kendi yazınızı yazın |
| [Yapılandırma](https://docs.befailproof.ai/configuration) | Yapılandırma kapsamları ve birleştirme kuralları |
| [Pano](https://docs.befailproof.ai/dashboard) | Oturum monitörü ve politika etkinliği |
| [Mimari](https://docs.befailproof.ai/architecture) | Hook sistemi nasıl çalışır |

---

## Lisans

MIT ve [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsizdir; failproofai'ın ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](./LICENSE) dosyasına bakın.

---

## Katkıda bulunma

[CONTRIBUTING.md](./CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, kenar durumlar ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce derleyin.** İlk önce `bun install && bun run build` komutunu çalıştırın. Bu depo kendisi üzerinde
> failproofai'nin hook'larını çalıştırır ve `failproofai` importu derlenmiş `dist/` bundle'ı
> doğru şekilde çözer — yapılandırma olmadan hook hataları `Cannot find package 'failproofai'` alırsınız.
> `src/` değiştikten sonra yeniden derleyin. Bkz.
> [Depoyu içindeki dev hook'ların çalışması için başında yapı](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

[Nivedit Jain](https://github.com/NiveditJain) ve [Nikita Agarwal](https://github.com/nk-ag) tarafından inşa edilmiştir.
[befailproof.ai](https://befailproof.ai)
