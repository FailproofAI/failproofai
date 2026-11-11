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

**Ajanlarınızın çalıştığı her ortamı gözlemle ve kontrol et.**
Ajanlarınız nerede çalışırsa çalışsın, biz bunu görüyoruz — ve hayır diyebiliriz. Failproof, 12 ajan ortamına bağlanır — Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi barındırulan asistanlar — her çalıştırmayı yakalar ve tehlikeli araç çağrılarını yürütülmeden önce engeller. 40 yerleşik politika. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI iş başında" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfa ayrılan on iki ortam — on kodlama CLI'sı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Tümü için bir politika API'si ve bir oturum geçmişi. Bir politikanın *engellediği* ortam başınadır: araç çağrısını çalıştırılmadan önce durdurmak tüm on ikisinde doğrulanır, oturum sonu kapıları sekizde çalışır. [Ortam başına matris](https://docs.befailproof.ai/reference/harnesses#enforcement-capability) her birinin işlediği olayları listeler.

Hiçbirinde çalışmayan ajanlar [Python SDK'sı](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla raporlanır; bu size izleme, oturumlar ve denetim sağlar. Orada uygulama, kendi çalışma zamanınızda bir kancaya ihtiyaç duyar — [bize ulaşın](mailto:support@befailproof.ai) ve biz bunu harita oluştururuz.

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
failproofai config                             # ajanlarınızı ve daemon'u bağlayın
failproofai policies add FailproofAI/policies  # ne uygulayacağınızı seçin
failproofai                                    # localhost:8020'de dashboard
```

Kurulum, kancaları bağlar ve **hiçbir** politika seçmez — bu ikinci komut, makinaya korkuluk koyan şeydir ve herhangi bir paket aynı şekilde yazılır (`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` önce birini okur). `failproofai config`'i terminal olmadan çalıştırın — CI, bir kapsayıcı, bir ajan bunu çalıştırırken — ve soru sorması yerine uygulanır. Hiç kurulumu yapmamış bir makinede, başka herhangi bir komut önce aynı sihirbazı çalıştırır; bunu `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

Bir paket gelinceye kadar, uygulama yapan tek şey `block-failproofai-commands`'tir; bu her zaman açıktır ve kapatılamaz veya duraklatılamaz: uygulamayı duraklatabilecek bir ajan diğer tüm politikaları kapatabilir.

---

## Neleri engeller

| Politika | Neleri engeller |
|---|---|
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Ajanın aynı çağrıda döngüye girmesi |
| `block-sudo` | Ayrıcalık yükseltmesi |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırlandırılmamış `DELETE` |
| `block-terraform` / `block-kubectl` | İncelenmemiş canlı altyapı değişiklikleri |
| `block-rm-rf` | Yinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main`'e doğrudan itme |

Bunların her biri çağrıyı çalıştırılmadan önce engeller, bu nedenle tüm on iki ortamda çalışırlar. İlk dördü, araç çağırabilen herhangi bir ajana uygulanır; son üçü geliştirici favori havuzudur — kodlama CLI'ları, en derinlemesine kapsadığımız ortam sınıfıdır. `sanitize-*` ailesi ayrıdır: bir araç döndüğünde çalışır, bu nedenle araç çıktısındaki bir sırrı bağlama koymaktan ziyade raporlar.

→ [Tüm 40 yerleşik politika](https://docs.befailproof.ai/policies/packs)

---

## Kendi politikalarınız

`.failproofai/policies/` klasörüne bir dosya atın — otomatik olarak yüklenir, bayrak gerekmez.
Bunu yayınlayın ve tüm ekip bir sonraki çekişte onu alır.

```js
import { customPolicies, deny, allow } from "failproofai";

customPolicies.add({
  name: "no-production-writes",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolInput?.file_path?.includes("production"))
      return deny("Yazımlar üretim yollarına engellenir.");
    return allow();
  },
});
```

Her politika için kullanılabilecek üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — mesaj ajana geri döner |
| `instruct(message)` | İzin ver, ama ajana bir sonraki isteme bağlam ekle |

→ [Politika yazma](https://docs.befailproof.ai/policies/editor)

---

## Gözlemlenebilirlik

Uygulama yarısıdır. Diğer yarısı, ajanın gerçekte ne yaptığını görmektir.

`failproofai`'yi hiçbir argüman olmadan çalıştırın ve makinenizde zaten bulunan çalıştırma geçmişini okuyan `localhost:8020`'de bir dashboard sunar — hesap yok, kaydolma yok, kutudan hiçbir şey çıkmaz. Oturum listesini, her çalıştırma içindeki model çağrıları, araç çağrıları ve kanca kararlarının dizisini, nelerin engellediğini ve politikanın ajana ne söylediğini ve çalıştırma geçmişinizi riskli kalıplar için tarayan çevrimdışı denetimi (`failproofai audit`) alırsınız ve bunları durdurmak için politikaları önerir.

→ [Yerel dashboard](https://docs.befailproof.ai/reference/local-dashboard) ·
[Bir izlemeyi oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği** aynı veri modelinin barındırılan tarafıdır; bir filoda ajanlar çalıştıran takımlar için: bir yerde tüm ortamlardan her çalıştırma, paralel alt-ajanları kendi şeritlerinde taşıyan bir yürütme grafiği, modeller, araçlar ve kancalar için p50/p95/p99 gecikme, model başına maliyet ve bağlam penceresi izleme, hata izleme, izleme paylaşılabilir panolarla SQL, kendi hizmetiniz tarafından puanlanan değerlendirmeler, tekrarlayan başarısızlıkları kanıta dayalı bulgulara dönüştüren zamanlanan denetimler ve Slack, e-posta veya imzalı webhooks'a yönlendirilen uyarılar. Kendi kümenizde kendi barındırma, Enterprise planında mevcuttur.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo kitabı](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başla | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükle, bir ortamı bağla, ilk çalıştırmayı gör |
| [Kavramlar](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | 12'nin tümü ve her birinin ne uygulayabileceği |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalıştırmayı izle: modeller, araçlar, hatalar, gecikme |
| [Bir izlemeyi oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği sana ne anlatıyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturum genelinde başarısızlık kalıplarını bul |
| [Yerel dashboard](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekmez |

| Uy | |
|---|---|
| [Politika paketleri](https://docs.befailproof.ai/policies/packs) | Failproof AI politikaları ve politika hub'ındaki paketler |
| [Politika yazma](https://docs.befailproof.ai/policies/editor) | Bir denetimden veya kod içinde |
| [Konfigürasyon](https://docs.befailproof.ai/policies/local-configuration) | Konfigürasyon kapsamları, birleştirme kuralları ve politika parametreleri |

| Kendi ajanınızı alet edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Ortamı olmayan bir ajandan çalıştırmaları raporla |
| [Politika SDK'sı](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

MIT ile [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'nin kendisinin ticari satışı ayrı bir sözleşme gerektirir. Tam metin için [LICENSE](../../LICENSE) dosyasına bakın.

---

## Katkıda bulunma

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Yeni politikalar, uç durumlar ve çeviriler hoş geldiniz.

---

❤️ tarafından [befailproof.ai](https://befailproof.ai) tarafından SF ve Bengaluru'da yapılmıştır.
