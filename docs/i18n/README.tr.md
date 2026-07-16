> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.gg/2zjBZP7yQJ)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/introduction)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](./LICENSE)

**Çeviriler:** [简体中文](./docs/i18n/README.zh.md) · [日本語](./docs/i18n/README.ja.md) · [한국어](./docs/i18n/README.ko.md) · [Español](./docs/i18n/README.es.md) · [Português](./docs/i18n/README.pt-br.md) · [Deutsch](./docs/i18n/README.de.md) · [Français](./docs/i18n/README.fr.md) · [Русский](./docs/i18n/README.ru.md) · [हिन्दी](./docs/i18n/README.hi.md) · [Türkçe](./docs/i18n/README.tr.md) · [Tiếng Việt](./docs/i18n/README.vi.md) · [Italiano](./docs/i18n/README.it.md) · [العربية](./docs/i18n/README.ar.md) · [עברית](./docs/i18n/README.he.md)

**Kodlama ajanları için çalışma zamanı hata çözümü.**
Claude Code ve Codex'e bağlanır. Döngüleri, tehlikeli eylemleri ve sır sızıntılarını
olay haline gelmeden yakalar. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI in action" width="800" />
</p>

---

## Desteklenen ajan CLIleri

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

> Bir veya herhangi bir kombinasyon için hook'ları kurun: `failproofai policies --install --cli opencode pi` (veya `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Kurulu CLIleri otomatik olarak algılamak ve isteme almak için `--cli` kısmını atlayın.
>
> **Hermes** (hermes-agent, Slack/Telegram geçidi) hem **canlı hook zorlama** (`--cli hermes` — bir kurulum her platformdan ve alt ajantan gelen araç çağrılarını engeller) hem de çevrimdışı **denetim** olarak desteklenir. Ağ geçidi oturumlarının yeniden oynatılması tek bir `~/.hermes/state.db` dosyasından yapılır.
>
> **OpenClaw** (openclaw geçidi, kendinden barındırılan çok kanallı asistan) hem **canlı hook zorlama** (`--cli openclaw`, kullanıcı kapsamı) hem de çevrimdışı **denetim** olarak desteklenir. JSONL oturumlarının yeniden oynatılması (`~/.openclaw/agents/<id>/sessions/*.jsonl`). Zorlama, OpenClaw'un **işlem içi eklenti hook'larını** kullanır (sevk edilmiş `openclaw-plugin/` failproofai'yi asenkron olarak başlatır — dosya tabanlı iç hook'ları yalnızca gözlemdir ve engellemeyi bloke edemez): `before_tool_call` bir aracı engeller ve `before_agent_finalize` gerçek bir tur sonu kapısıdır, bu nedenle `require-*-before-stop` yerleşik özellikleri zorlama uygular.
>
> **Factory Droid** (`droid`) hem **canlı hook zorlama** (`--cli factory`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** olarak desteklenir. Disk üstündeki JSONL oturumlarının yeniden oynatılması. droid, hook **çıkış kodu 2** (JSON kararı değil) devre dışı bırakır ve `{decision:"block"}` yalnızca tur sonu `Stop` olayında onurlandırır — failproofai her olay için otomatik olarak doğru şekli yayınlar.
>
> **Devin CLI** (`devin`, Cognition) hem **canlı hook zorlama** (`--cli devin`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** olarak desteklenir. SQLite oturumlarının yeniden oynatılması (`~/.local/share/devin/cli/sessions.db`). Devin, **saf Claude kopyası** — aynı olay adları, aynı snake_case yükü, aynı `"hooks"`-sarmalayıcı config (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — her olayda `{decision:"block"}` JSON aracılığıyla engelleme.
>
> **Antigravity CLI** (`agy`) hem **canlı hook zorlama** (`--cli antigravity`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** olarak desteklenir. Düz JSONL oturumlarının yeniden oynatılması (`~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl`). Antigravity'nin **kendi** sözleşmesi vardır (Claude kopyası değil): **adlandırılmış hook** `hooks.json` şeması (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), failproofai'nin normalleştirdiği camelCase stdin yükü ve kendi yanıt şekilleri — bir aracı engellemek için `{decision:"deny"}`, `Stop` konumunda başka bir tur zorlamak için `{decision:"continue"}`, model çalışmadan önce bir hatırlatıcı enjekte etmek için `{injectSteps}`.
>
> **Goose** (kodadı goose, Block) hem **canlı hook zorlama** (`--cli goose`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** olarak desteklenir. SQLite oturumlarının yeniden oynatılması (`~/.local/share/goose/sessions/sessions.db`). Zorlama, Goose'un **hooks** sistemini kullanır (platformlar arası **Open Plugins** spesifikasyonu) — yükleyici sadece bir eklenti dizini `~/.agents/plugins/failproofai/` konumuna bırakır ve Goose otomatik olarak keşfeder. Engelleme, `PreToolUse` olayında `{"decision":"block"}` JSON'udur (shell aracı ve devredilen alt ajanlar içinde ateşlenir), goose v1.43.0 sürümüne karşı canlı olarak doğrulanır; Goose'un `Stop` tur sonu olayı yoktur, bu nedenle `require-*-before-stop` yerleşik özellikleri uygulanmaz (Hermes'te olduğu gibi).

---

## Kurulum

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırın ve ilk çalışma istemini kabul edin
failproofai
```

30 yerleşik ilke hemen etkinleştirilir. Pano `localhost:8020` adresinde. `FAILPROOFAI_NO_FIRST_RUN=1` ile ilk çalışma istemini devre dışı bırakın.

---

## Ne engeller

| İlke | Ne engeller |
|---|---|
| `block-push-master` | `main` / `master` direktif gönderileri |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` üzerinde işlemeler, birleştirmeler, taban değişiklikleri |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `sanitize-api-keys` | Ajan bağlamına sızan API anahtarları |

→ [Tüm 30 yerleşik ilke](https://docs.befailproof.ai/built-in-policies)

---

## Kendi ilkeleriniz

`.failproofai/policies/` dizinine bir dosya bırakın — otomatik olarak yüklenir, bayrak gerekmez.
Bunu commit edin ve tüm takım sonraki çekme sırasında alır.

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

Her ilke için mevcut olan üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — ileti ajana geri gider |
| `instruct(message)` | Bunu geçir ama ajanın sonraki istemesine bağlam ekle |

→ [Özel ilkeler rehberi](https://docs.befailproof.ai/custom-policies)

---

## Oturum görünürlüğü

Ajanınızın yaptığı her araç çağrısı yerel olarak kaydedilir. Pano ne çalıştığını,
ne engellediğini ve ilkenin ajana ne söylediğini gösterir — bu nedenle
bir şey ters gittiğinde tahmin etmiyorsunuz. → [Pano rehberi](https://docs.befailproof.ai/dashboard)

---

## Belgeler

| | |
|---|---|
| [Başlangıç](https://docs.befailproof.ai/getting-started) | Kurulum ve ilk adımlar |
| [Yerleşik İlkeler](https://docs.befailproof.ai/built-in-policies) | 30 ilkenin tümü parametreler ile |
| [Özel İlkeler](https://docs.befailproof.ai/custom-policies) | Kendi kurallarınızı yazın |
| [Yapılandırma](https://docs.befailproof.ai/configuration) | Konfigürasyon kapsamları ve birleştirme kuralları |
| [Pano](https://docs.befailproof.ai/dashboard) | Oturum monitörü ve ilke etkinliği |
| [Mimari](https://docs.befailproof.ai/architecture) | Hook sistemi nasıl çalışır |

---

## Lisans

MIT ile [Commons Clause](https://commonsclause.com/) — iç ve kişisel kullanım için ücretsiz; failproofai'nin kendisinin ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LİSANS](./LICENSE) bölümüne bakın.

---

## Katkı Sağlama

[CONTRIBUTING.md](./CONTRIBUTING.md) dosyasına bakın. Yeni ilkeler, uç durumlar ve çeviriler hoş geldiniz.

> **Başlamadan önce derleyin.** Önce `bun install && bun run build` çalıştırın. Bu depo failproofai'nin kendi hook'larını kendisinde çalıştırır ve `failproofai` içe aktarılmasını derlenmiş `dist/` paketine karşı çözerler — derleme olmadan `Cannot find package 'failproofai'` hook hataları alırsınız. `src/` değiştirildikten sonra yeniden derleyin. Bkz. [In-repo dev hook'larının çalışması için önce derleyin](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

Tarafından yapıldı [Nivedit Jain](https://github.com/NiveditJain) ve [Nikita Agarwal](https://github.com/nk-ag).
[befailproof.ai](https://befailproof.ai)
