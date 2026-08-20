> **⚠️** This is an auto-generated translation. For the latest version, see the [English README](../../README.md). Community corrections welcome!

[🇺🇸 English](../../README.md) | [🇨🇳 简体中文](README.zh.md) | [🇯🇵 日本語](README.ja.md) | [🇰🇷 한국어](README.ko.md) | [🇪🇸 Español](README.es.md) | [🇧🇷 Português](README.pt-br.md) | [🇩🇪 Deutsch](README.de.md) | [🇫🇷 Français](README.fr.md) | [🇷🇺 Русский](README.ru.md) | [🇮🇳 हिन्दी](README.hi.md) | **🇹🇷 Türkçe** | [🇻🇳 Tiếng Việt](README.vi.md) | [🇮🇹 Italiano](README.it.md) | [🇸🇦 العربية](README.ar.md) | [🇮🇱 עברית](README.he.md)

---

<div align="center">

<img src="https://d2wq11aau0arks.cloudfront.net/failproof/fa_updated_full.svg" alt="failproof ai" width="220" />

[![npm](https://img.shields.io/npm/v/failproofai?style=flat-square&color=CB3837)](https://www.npmjs.com/package/failproofai)
[![CI](https://img.shields.io/github/actions/workflow/status/failproofai/failproofai/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/failproofai/failproofai/actions)
[![Supply Chain](https://img.shields.io/badge/supply%20chain-secure-brightgreen?style=flat-square)](https://github.com/failproofai/failproofai/actions/workflows/osv-scanner.yml)
[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?style=flat-square&logo=discord)](https://discord.befailproof.ai/)
[![Docs](https://img.shields.io/badge/docs-befailproof.ai-002CA7?style=flat-square)](https://docs.befailproof.ai/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue?style=flat-square)](../../LICENSE)

**Çeviriler:** [简体中文](../../docs-old/i18n/README.zh.md) · [日本語](../../docs-old/i18n/README.ja.md) · [한국어](../../docs-old/i18n/README.ko.md) · [Español](../../docs-old/i18n/README.es.md) · [Português](../../docs-old/i18n/README.pt-br.md) · [Deutsch](../../docs-old/i18n/README.de.md) · [Français](../../docs-old/i18n/README.fr.md) · [Руссий](../../docs-old/i18n/README.ru.md) · [हिन्दी](../../docs-old/i18n/README.hi.md) · [Türkçe](../../docs-old/i18n/README.tr.md) · [Tiếng Việt](../../docs-old/i18n/README.vi.md) · [Italiano](../../docs-old/i18n/README.it.md) · [العربية](../../docs-old/i18n/README.ar.md) · [עברית](../../docs-old/i18n/README.he.md)

**Kodlama ajanları için çalışma zamanı hata çözümü.**
Claude Code ve Codex'e bağlanır. Döngüleri, tehlikeli işlemleri ve gizli bilgi sızıntılarını
bunlar olay haline gelmeden önce yakalar. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI çalışırken" width="800" />
</p>

---

## Desteklenen aracı CLI'lar

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

## Yükleyin

```sh
npm install -g failproofai
failproofai policies --install   # veya sadece `failproofai` çalıştırıp ilk çalışma istemini kabul edin
failproofai
```

30 yerleşik politika hemen etkinleşir. Panel `localhost:8020` adresinde. İlk çalışma istemini `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

---

## Neleri engeller

| Politika | Ne engeller |
|---|---|
| `block-push-master` | `main` / `master` üzerine doğrudan push'lar |
| `block-force-push` | `git push --force` |
| `block-work-on-main` | `main` / `master` üzerinde commit'ler, merge'ler, rebase'ler |
| `block-rm-rf` | Tekrarlayan dosya silme işlemleri |
| `sanitize-api-keys` | API anahtarlarının aracı bağlamına sızması |

→ [30 yerleşik politikanın tümü](https://docs.befailproof.ai/policies/builtin)

---

## Kendi politikalarınız

`.failproofai/policies/` klasörüne bir dosya bırakın — otomatik olarak yüklenir, hiçbir bayrak gerekmez.
Commit'leyin ve tüm ekip bir sonraki pull'da alacaktır.

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
| `deny(message)` | Engelle — ileti aracıya geri döner |
| `instruct(message)` | Geçmesine izin ver, ancak aracının sonraki isteminde bağlam ekle |

→ [Özel politikalar rehberi](https://docs.befailproof.ai/policies/custom)

---

## Oturum görünürlüğü

Aracınızın yaptığı her araç çağrısı yerel olarak kaydedilir. Panel, neyin çalıştığını,
neyin engellendiğini ve politikanın aracıya ne söylediğini gösterir — bu nedenle
bir şeyler ters gittiğinde tahmin etmiyorsunuz. → [Panel rehberi](https://docs.befailproof.ai/sessions/overview)

---

## Belgeler

| | |
|---|---|
| [Başlarken](https://docs.befailproof.ai/start/quickstart) | Yükleme ve ilk adımlar |
| [Yerleşik Politikalar](https://docs.befailproof.ai/policies/builtin) | 30 politikanın tümü ve parametreleri |
| [Özel Politikalar](https://docs.befailproof.ai/policies/custom) | Kendi politikalarınızı yazın |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Yapılandırma kapsamları ve birleştirme kuralları |
| [Panel](https://docs.befailproof.ai/sessions/overview) | Oturum izleyici ve politika aktivitesi |
| [Mimari](https://docs.befailproof.ai/start/concepts) | Hook sistem nasıl çalışır |

---

## Lisans

MIT with [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'nin ticari satışı ayrı bir anlaşma gerektirir. Tam metin için [LICENSE](../../LICENSE) dosyasına bakın.

---

## Katkıda Bulunma

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, kenar durumları ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce oluşturun.** Önce `bun install && bun run build` çalıştırın. Bu depo, failproofai'nin kendi hook'larını kendisinde çalıştırır ve `failproofai` import'unu derlenmiş `dist/` paketi'ne karşı çözer — inşa olmadan `Cannot find package 'failproofai'` hook hatalarıyla karşılaşırsınız. `src/` değiştirdikten sonra yeniden derleyin. [Hook'ların depoda çalışması için önce oluşturun](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

❤️ ile [befailproof.ai](https://befailproof.ai) tarafından SF ve Bengaluru'da oluşturuldu.
