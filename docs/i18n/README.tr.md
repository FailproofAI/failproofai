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

**Aracılarınızın çalıştığı her ortam için gözlemlenebilirlik ve zorlama.**
Aracılarınız nerede çalışırsa çalışsın, biz onu görebiliriz — ve hayır diyebiliriz. Failproof, 12 aracı ortamına bağlanır — Claude Code ve Codex gibi kodlama CLI'ları, Hermes gibi sohbet ağ geçitleri, OpenClaw gibi kendi kendine barındırılan asistanlar — her çalıştırmayı yakalar ve yürütülmeden önce tehlikeli araç çağrılarını engeller. 43 yerleşik ilke. Sıfır gecikme. Yerel olarak çalışır.

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/FailproofAI/failproofai/main/readme-arch-hq.gif" alt="Failproof AI uygulamada" width="800" />
</p>

---

## Desteklenen ortamlar

İki sınıfta on iki ortam — on kodlama CLI'ı ve iki sohbet ve asistan ağ geçidi (Hermes, OpenClaw). Tüm ortamlar arasında bir ilke API'ı ve bir oturum geçmişi. Bir ilkenin *engelleyebileceği* ortama özgüdür: bir araç çağrısını çalıştırmadan önce durdurmak tüm on ikide doğrulanır, oturum sonu kapıları sekizde açılır. [Ortama özgü matris](https://docs.befailproof.ai/reference/harnesses#enforcement-capability), her birinin hangi olayları onurlandırdığını listeler.

Bunlardan hiçbirinde çalışmayan aracılar [Python SDK](https://docs.befailproof.ai/reference/custom-agents) aracılığıyla raporlanır; bu size izleme, oturumlar ve denetimler verir. Orada zorlama, kendi çalışma zamanınıza bir kanca takılmasını gerektirir — [bizimle iletişime geçin](mailto:support@befailproof.ai) ve biz onu eşleştireceğiz.

{/* Satır içi <img> çalışmalarının yerine 6 sütunlu bir tablo: tablo sütunları hiçbir zaman yeniden kaydırılmaz,
     bu nedenle ızgara herhangi bir pencere genişliğinde 2×6 kalır (çok dar ekranlarda kaydırma
     bunun yerine düzensiz yetim satırlara çökmek). */}
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
failproofai policies add FailproofAI/policies  # neleri uygulayacağınızı seçin
failproofai                                    # localhost:8020 üzerinde kontrol paneli
```

Kurulum, kancaları bağlar ve **hiçbir** ilke seçmez — ikinci komut, makinede güvenlik duvarları koyan şeydir ve herhangi bir paket aynı şekilde yazılır
(`failproofai policies add <owner>/<repo>`; `policies show <owner>/<repo>` önce birini okur). Terminal olmadan `failproofai config` çalıştırın — CI, bir konteyner, onu yöneten bir aracı — ve sorular sormak yerine uygular. Hiçbir zaman kurulmamış bir makinede, başka herhangi bir komut önce aynı sihirbazı çalıştırır; bunu `FAILPROOFAI_NO_FIRST_RUN=1` ile devre dışı bırakın.

Bir paket gelene kadar, uygulamayı yapan tek şey `block-failproofai-commands`, her zaman açık olan ve kapatılamayan veya duraklatılamayan şeydir: zorlamayı duraklatabilecek bir aracı, diğer her ilkeyi açabilir.

---

## Neyi engeller

| İlke | Neyi engeller |
|---|---|
| `block-env-files` | `.env` ve diğer gizli dosyaların okunması |
| `warn-repeated-tool-calls` | Aracının aynı çağrıda döngüye girmesi |
| `block-sudo` | Ayrıcalık yükseltme |
| `warn-destructive-sql` | `DROP`, `TRUNCATE`, sınırlanmamış `DELETE` |
| `block-terraform` / `block-kubectl` | Canlı altyapıya gözden geçirilmemiş değişiklikler |
| `block-rm-rf` | Özyinelemeli dosya silme |
| `block-force-push` / `block-push-master` | `git push --force`, `main` üzerine doğrudan itme |

Bu komutların hepsi çağrısı çalıştırmadan önce kapıdan geçer, bu nedenle tüm on iki ortamda geçerlidirler. İlk dördü, bir aracı çağrı yapabilen herhangi bir araçla geçerlidir; sonuncu üçü geliştirici favorileridir — kodlama CLI'ları en derin kapladığımız ortam sınıfıdır. `sanitize-*` ailesi ayrıdır: bir araç döndükten sonra çalışır, bu nedenle bağlamdan onu tutmak yerine araç çıktısında bir gizli kodunu bildirir.

→ [Tüm 43 yerleşik ilke](https://docs.befailproof.ai/policies/packs)

---

## Kendi ilkeleriniz

`.failproofai/policies/` içine bir dosya bırakın — otomatik olarak yüklenir, bayrak gerekmez.
Onu işleyin ve tüm takım bir sonraki çekişte onu alır.

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

Her ilke için kullanılabilir üç karar:

| Karar | Etki |
|---|---|
| `allow()` | İşleme izin ver |
| `deny(message)` | Engelle — ileti aracıya geri gider |
| `instruct(message)` | Geçmesine izin ver, ancak aracının sonraki komutuna bağlam ekle |

→ [İlke yaz](https://docs.befailproof.ai/policies/editor)

---

## Gözlemlenebilirlik

Zorlama bir yarısıdır. Diğer yarısı, aracının gerçekten ne yaptığını görmektir.

`failproofai`yi argument olmadan çalıştırın ve `localhost:8020` üzerinde makinenizde zaten olan çalıştırma geçmişini okuyan bir kontrol paneli sunar — hesap yok, kaydolma yok, hiçbir şey kutunun dışına çıkmaz. Oturum listesini, her çalıştırmanın içinde model çağrılarının, araç çağrılarının ve kanca kararlarının sırasını, neyin engellendiğini ve ilkenin aracıya ne söylediğini alırsınız ve risky modelleri taradığınız ve onları durdurmak için ilkeler önerdiği çevrimdışı bir denetim (`failproofai audit`).

→ [Yerel kontrol paneli](https://docs.befailproof.ai/reference/local-dashboard) ·
[İz oku](https://docs.befailproof.ai/sessions/read-a-trace) ·
[Yerel denetim](https://docs.befailproof.ai/audits/local-audit)

**Failproof AI Gözlemlenebilirliği**, aynı veri modelinin barındırılan tarafıdır, bir filo genelinde aracılar çalıştıran takımlar için: her ortamın her çalıştırması tek bir yerde, paralel alt-aracıların kendi şeritlerinde olduğu bir yürütme grafiği, modeller, araçlar ve kancalar için p50/p95/p99 gecikme, modele göre maliyet ve bağlam-penceresi izleme, hata izleme, kendi izleriiniz üzerinde SQL paylaşılabilir panolarla, kendi hizmetiniz tarafından puanlanan değerlendirmeler, yinelenen başarısızlıkları kanıta dayalı bulgulara dönüştüren planlanan denetimler ve uyarılar Slack, e-posta veya imzalı bir webhook'a yönlendirilir. Kendi kümenizde kendi kendine barındırma, Enterprise planında mevcuttur.

→ [Oturumlar](https://docs.befailproof.ai/sessions/overview) ·
[Denetimler](https://docs.befailproof.ai/audits/overview) ·
[Demo kitapla](https://befailproof.ai/get-a-demo)

---

## Belgeler

| Başlat | |
|---|---|
| [Hızlı başlangıç](https://docs.befailproof.ai/start/quickstart) | Yükle, bir ortamı bağla, ilk çalıştırmayı gör |
| [Konseptler](https://docs.befailproof.ai/start/concepts) | Kanca sistemi nasıl çalışır |
| [Desteklenen ortamlar](https://docs.befailproof.ai/reference/harnesses) | Tüm 12 ve her birinin neleri uygulayabileceği |

| Gözlemle | |
|---|---|
| [Oturumlar](https://docs.befailproof.ai/sessions/overview) | Bir çalıştırmayı takip et: modeller, araçlar, hatalar, gecikme |
| [İz oku](https://docs.befailproof.ai/sessions/read-a-trace) | Yürütme grafiği sana ne söylüyor |
| [Denetimler](https://docs.befailproof.ai/audits/overview) | Birçok oturum arasında başarısızlık modellerini bul |
| [Yerel kontrol paneli](https://docs.befailproof.ai/reference/local-dashboard) | `localhost:8020`, hesap gerekli değil |

| Uygula | |
|---|---|
| [İlke paketleri](https://docs.befailproof.ai/policies/packs) | Failproof AI ilkeleri ve ilke merkezi'nden paketler |
| [İlke yaz](https://docs.befailproof.ai/policies/editor) | Bir denetimden veya kodda |
| [Yapılandırma](https://docs.befailproof.ai/policies/local-configuration) | Konfigürasyon kapsamları, birleştirme kuralları ve ilke parametreleri |

| Kendi aracınızı enstrüman edin | |
|---|---|
| [Python SDK](https://docs.befailproof.ai/reference/custom-agents) | Ortamı olmayan bir aracıdan çalıştırmaları raporla |
| [İlke SDK](https://docs.befailproof.ai/reference/policy-sdk) | `allow` / `deny` / `instruct` referansı |

---

## Lisans

MIT [Commons Clause](https://commonsclause.com/) — dahili ve kişisel kullanım için ücretsiz; failproofai'in ticari yeniden satışı ayrı bir anlaşma gerektirir. Tam metin için [LİSANS](../../LICENSE) bölümüne bakın.

---

## Katkıda bulunma

[CONTRIBUTING.md](../../CONTRIBUTING.md) bölümüne bakın. Yeni ilkeler, edge case'ler ve çeviriler hepsi hoş geldiniz.

> **Başlamadan önce oluşturun.** Önce `bun install && bun run build` çalıştırın. Bu depo, failproofai'in kendi kancalarını kendisinde çalıştırır ve `failproofai` içe aktarmasını derlenmiş `dist/` paketine karşı çözerler — bir derleme olmadan `Cannot find package 'failproofai'` kanca hatalarına çarparsınız. `src/` değiştirildikten sonra yeniden derleyin. Bkz. [İçi repo dev kancaları çalışmaya başlayacak şekilde önce oluşturun](../../CONTRIBUTING.md#build-before-the-in-repo-dev-hooks-will-work).

---

SF ve Bengaluru'da [befailproof.ai](https://befailproof.ai) tarafından ❤️ ile inşa edildi.
