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
Claude Code ve Codex'e bağlanır. Döngüleri, tehlikeli işlemleri ve gizli bilgi sızıntılarını
sorun haline gelmeden önce yakalar. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="readme-arch-hq.gif" alt="Failproof AI aksiyonda" width="800" />
</p>

---

## Desteklenen ajan CLIsı

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code">
    <img src="assets/logos/claude.svg" alt="Claude Code" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://learn.chatgpt.com" title="OpenAI Codex">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/openai-dark.svg" />
      <img src="assets/logos/openai-light.svg" alt="OpenAI Codex" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/features/copilot/cli" title="GitHub Copilot CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/copilot-dark.svg" />
      <img src="assets/logos/copilot-light.svg" alt="GitHub Copilot" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor Agent CLI">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/cursor-dark.svg" />
      <img src="assets/logos/cursor-light.svg" alt="Cursor Agent" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://opencode.ai/" title="OpenCode">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/opencode-dark.svg" />
      <img src="assets/logos/opencode-light.svg" alt="OpenCode" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pi.dev/" title="Pi (pi-coding-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/pi-dark.svg" />
      <img src="assets/logos/pi-light.svg" alt="Pi" width="64" height="64" />
    </picture>
  </a>
</p>
<p align="center">
  <a href="https://hermes-agent.nousresearch.com/" title="Hermes (hermes-agent)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/hermes-dark.svg" />
      <img src="assets/logos/hermes-light.svg" alt="Hermes" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openclaw.ai/" title="OpenClaw (openclaw gateway)">
    <img src="assets/logos/openclaw.svg" alt="OpenClaw" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://factory.ai/" title="Factory Droid (droid)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/factory-dark.png" />
      <img src="assets/logos/factory-light.png" alt="Factory Droid" width="64" height="64" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://devin.ai" title="Devin CLI (Cognition)">
    <img src="assets/logos/devin.svg" alt="Devin CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://antigravity.google" title="Antigravity CLI (agy)">
    <img src="assets/logos/antigravity.svg" alt="Antigravity CLI" width="64" height="64" />
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://goose-docs.ai/" title="Goose (codename goose)">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logos/goose-dark.svg" />
      <img src="assets/logos/goose-light.svg" alt="Goose" width="64" height="64" />
    </picture>
  </a>
</p>

> Bir veya daha fazla kombinasyon için hook yükleyin: `failproofai policies --install --cli opencode pi` (veya `--cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose`). Kurulu CLIsları otomatik olarak algılamak ve sorulmak için `--cli` seçeneğini atla.
>
> **Hermes** (hermes-agent, bir Slack/Telegram ağ geçidi) hem **canlı-hook zorlama** (`--cli hermes` — tek bir yükleme her platform ve alt ajantan gelen araç çağrılarını engeller) hem de çevrimdışı **denetim** yürütmesi için desteklenir `~/.hermes/state.db` adresinden.
>
> **OpenClaw** (openclaw ağ geçidi, kendi kendine barındırılan çok kanallı asistan) hem **canlı-hook zorlama** (`--cli openclaw`, kullanıcı kapsamı) hem de çevrimdışı **denetim** yürütmesi için desteklenir `~/.openclaw/agents/<id>/sessions/*.jsonl` adresinden. Zorlama, OpenClaw'ın **süreç içi eklenti hook'larını** kullanır (failproofai'yi eşzamansız olarak oluşturan sevk edilmiş bir `openclaw-plugin/` — dosya tabanlı iç hook'ları yalnızca gözlem amaçlıdır ve engelle kabiliyetine sahip değildir): `before_tool_call` bir aracı engeller ve `before_agent_finalize` gerçek bir dönem sonu kapısıdır, bu nedenle `require-*-before-stop` yerleşik özellikleri uygular.
>
> **Factory Droid** (`droid`) hem **canlı-hook zorlama** (`--cli factory`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** yürütmesi için desteklenir. droid araç çağrılarını hook çıkış kodu 2'de engeller (JSON kararı değil) ve `{decision:"block"}` yalnızca dönem sonu `Stop` olayında onurlandırır — failproofai olayın her biri için otomatik olarak doğru şekli yayar.
>
> **Devin CLI** (`devin`, Cognition) hem **canlı-hook zorlama** (`--cli devin`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** yürütmesi için desteklenir `~/.local/share/devin/cli/sessions.db` adresinden. Devin bir **saf Claude klonu**dur — aynı olay adları, aynı snake_case yükü, aynı `"hooks"`-sarmalayıcı yapılandırması (`~/.config/devin/config.json` / `<cwd>/.devin/config.json`) — her olay üzerinde `{decision:"block"}` JSON ile engelleme yapılır.
>
> **Antigravity CLI** (`agy`) hem **canlı-hook zorlama** (`--cli antigravity`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** yürütmesi için desteklenir `~/.gemini/antigravity-cli/brain/<id>/…/transcript_full.jsonl` adresinden. Antigravity'nin **kendi** sözleşmesi vardır (Claude klonu değil): bir **adlandırılmış-hook** `hooks.json` şeması (`~/.gemini/config/hooks.json` / `<cwd>/.agents/hooks.json`), failproofai'nin normalleştirdiği bir camelCase stdin yükü ve kendi yanıt şekilleri — bir aracı engelleme için `{decision:"deny"}`, `Stop` adresinde başka bir dönem zorlamak için `{decision:"continue"}`, model çalışmadan önce hatırlatıcı enjekte etmek için `{injectSteps}`.
>
> **Goose** (codename goose, Block) hem **canlı-hook zorlama** (`--cli goose`, kullanıcı + proje kapsamı) hem de çevrimdışı **denetim** yürütmesi için desteklenir `~/.local/share/goose/sessions/sessions.db` adresinden. Zorlama, Goose'un **hook'lar** sistemini kullanır (çok ajantan **Open Plugins** spesifikasyonu) — yükleyici sadece bir eklenti dizini `~/.agents/plugins/failproofai/` adresine düşürür ve Goose otomatik olarak keşfeder. Engelleme, `PreToolUse` olayında `{"decision":"block"}` JSON'dur (shell aracı ve temsilci edilen alt ajanlar için çalışır), goose v1.43.0'a karşı canlı olarak doğrulanır; Goose'un `Stop` olay adında bir dönem sonu yok, bu nedenle `require-*-before-stop` yerleşik özellikleri uygulanmaz (Hermes'te olduğu gibi).

---

## Yükle

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırın ve ilk çalıştırma isteğini kabul edin
failproofai
```

30 yerleşik politika hemen etkinleşir. Pano `localhost:8020` adresindedir. İlk çalıştırma isteğini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Neyi engeller?

| Politika | Engellediği şey |
|---|---|
| `block-push-master` | `main` / `master` adresine doğrudan itme |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` adresinde değişiklikler, birleştirmeler, rebase işlemleri |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `sanitize-api-keys` | API anahtarlarının ajan bağlamına sızması |

→ [Tüm 30 yerleşik politika](https://docs.befailproof.ai/built-in-policies)

---

## Kendi politikalarınız

`.failproofai/policies/` adresine bir dosya bırakın — otomatik olarak yüklenir, bayrak gerekmez.
Bunu işleyin ve tüm ekip bir sonraki çekişte bunu alacaktır.

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

Her politika için üç karar seçeneği mevcuttur:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — ileti ajanın yanında görünür |
| `instruct(message)` | Geçmesine izin ver, ancak ajanın bir sonraki istemesine bağlam ekle |

→ [Özel politikalar rehberi](https://docs.befailproof.ai/custom-policies)

---

## Oturum görünürlüğü

Ajanınız yaptığı her araç çağrısı yerel olarak kaydedilir. Pano, ne çalıştığını,
ne engellediğini ve politikanın ajanına ne söylediğini gösterir — bu nedenle
bir şey yanlış gittiğinde tahmin ediyorsunuz. → [Pano rehberi](https://docs.befailproof.ai/dashboard)

---

## Belgeler

| | |
|---|---|
| [Başlangıç](https://docs.befailproof.ai/getting-started) | Yükleme ve ilk adımlar |
| [Yerleşik Politikalar](https://docs.befailproof.ai/built-in-policies) | Tüm 30 politika parametreleriyle |
| [Özel Politikalar](https://docs.befailproof.ai/custom-policies) | Kendi politikanızı yazın |
| [Yapılandırma](https://docs.befailproof.ai/configuration) | Yapılandırma kapsamları ve birleştirme kuralları |
| [Pano](https://docs.befailproof.ai/dashboard) | Oturum monitörü ve politika etkinliği |
| [Mimari](https://docs.befailproof.ai/architecture) | Hook sistemi nasıl çalışır |

---

## Lisans

MIT ile [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'nin ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](./LICENSE) dosyasına bakın.

---

## Katkı

[CONTRIBUTING.md](./CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, uç durumlar ve çeviriler hoş geldiniz.

> **Başlamadan önce derle.** Önce `bun install && bun run build` komutunu çalıştırın. Bu depo failproofai'nin kendi hook'larını kendisinde çalıştırır ve `failproofai` ithalatını derlenmiş `dist/` paketi karşısında çözer — bir yapı olmadan `Cannot find package 'failproofai'` hook hataları oluşur. `src/` değiştirdikten sonra yeniden derleyin. [In-repo dev hook'ları çalışması için önce derle](./CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work) bölümüne bakın.

---

[Nivedit Jain](https://github.com/NiveditJain) ve [Nikita Agarwal](https://github.com/nk-ag) tarafından oluşturulmuştur.
[befailproof.ai](https://befailproof.ai)
