# Banking MCP Gateway — Mimari Doküman

**Sınıf:** Account Information Service Provider (AISP) Entegrasyon Katmanı  
**Durum:** Referans Mimari / Öğrenme Amaçlı Prototip

## 1. Yönetici Özeti & Mimari Kapsam
Banking MCP Gateway, bir büyük dil modeli (LLM) ajanının, Açık Bankacılık (Open Banking) API'leri üzerinden hesap ve işlem verisine AISP (Account Information Service Provider) rolüyle erişmesini sağlayan bir entegrasyon katmanıdır. Mimari, Least Privilege (En Az Yetki) prensibi doğrultusunda tasarlanmıştır: sistem yalnızca bilgi okuma (query/reporting) işlevi görür; PISP (Payment Initiation Service Provider) kapsamına giren fonksiyonlar (transfer, ödeme başlatma, kart yönetimi) mimari sınırların dışında tutulmuştur.

Bu kapsam daraltması, saldırı yüzeyini (attack surface) azaltan bir tasarım tercihidir ve kod seviyesinde statik olarak doğrulanabilir durumdadır (`AdapterCapabilities` tipi, bkz. Bölüm 4).

**Aktif sağlayıcı:** Garanti BBVA API Store (`src/infrastructure/adapters/garanti.adapter.ts`). Mimari çok-bankalı olacak şekilde tasarlanmış olsa da (bkz. Bölüm 3), bu projenin şu anki kapsamında yalnızca Garanti entegrasyonu aktif ve yapılandırılmıştır.

### Tasarım Hedefleri
| Hedef | Yaklaşım |
| :--- | :--- |
| Katmanlı sorumluluk ayrımı | Clean Architecture / Domain-Driven Design |
| Yatay ölçeklenebilirlik (çoklu banka) | Adapter + Registry (Open/Closed Principle) |
| Veri gizliliği | Merkezi maskeleme katmanı, PCI-DSS maskeleme ilkeleriyle hizalı |
| Operasyonel dayanıklılık | Retry, timeout, circuit breaker |
| İzlenebilirlik | Correlation ID tabanlı structured logging, audit trail |
| Girdi bütünlüğü | Şema tabanlı doğrulama (Zod), OWASP API Security ilkeleriyle hizalı |

### Referans ve Özgünlük Notu
Açık bankacılık entegrasyon domain pratikleri (Türk bankaları için OAuth 2.0 `client_credentials` akışı, hesap/hareket sorgulama ürün modeli) incelenerek; katmanlı mimari (Clean Architecture), Adapter/Registry örüntüleri, merkezi güvenlik ve dayanıklılık katmanları bu dokümanda enterprise ölçekte sıfırdan kurgulanmıştır. Kod organizasyonu, isimlendirme ve modül sınırları bağımsız mimari kararlardır.

## 2. Clean Architecture Katman Hiyerarşisi
- `src/domain/` (Katman 1 — Core Domain)
  - `models.ts` (`BankAccount`, `BankTransaction`, `Money`)
  - `errors.ts` (`BankAdapterError`, `ConfigurationError`)
- `src/application/` (Katman 2 — Application / Use Case)
  - `bank-adapter.port.ts` (`IBankAdapter` Port)
  - `bank-adapter.factory.ts` (`BankAdapterRegistry` Factory)
- `src/infrastructure/` (Katman 3 — Infrastructure)
  - `adapters/` (Dış sistem entegrasyonları - `oauth-bank-adapter.base.ts`, `garanti.adapter.ts`)
  - `security/sanitizer.ts` (PII/Secret Masking)
  - `observability/logger.ts` (Structured Logging & Audit Trail)
  - `resilience.ts` (Retry / Timeout / Circuit Breaker)
- `src/config/env.schema.ts` (Konfigürasyon Doğrulama - Zod)
- `src/presentation/mcp/tool-registry.ts` (Katman 4 — Presentation / MCP Protocol)
- `src/index.ts` (Composition Root)

### Bağımlılık Yönü (Dependency Inversion Principle)
- Presentation -> Application -> Domain
- Infrastructure -> Application (port'ları implemente eder)

`domain/` katmanı hiçbir üst katmana veya dış kütüphaneye (HTTP istemcisi, MCP SDK, ortam değişkeni) bağımlı değildir.

## 3. Genişletilebilirlik Modeli (Extensibility & Open/Closed Principle)
Yeni bir banka entegrasyonu, mevcut hiçbir dosya değiştirilmeden eklenir:
1. `OAuthBankAdapterBase` sınıfını extend eden yeni bir adaptör sınıfı oluşturulur (`src/infrastructure/adapters/<banka>.adapter.ts`).
2. Bankaya özgü response normalizasyon mantığı (`fetchAccountsFromApi`, `fetchTransactionsFromApi`) implemente edilir.
3. Adaptör, dosya sonunda `BankAdapterRegistry.register(...)` ile kaydedilir.
4. `index.ts` dosyasına tek satır import eklenir; aktif sağlayıcı ortam değişkeniyle (`ACTIVE_BANK_PROVIDER`) seçilir.

## 4. Güvenlik, Risk & Dayanıklılık Matrisi
| Mekanizma | İlgili Modül | Hizalı Olduğu İlke / Standart |
| :--- | :--- | :--- |
| Salt-okunur sınır (Read-Only Boundary) | `AdapterCapabilities`, `domain/models.ts` | Least Privilege, PSD2 AISP/PISP rol ayrımı |
| PII / Secret Masking (IBAN, kart no, TCKN, token) | `infrastructure/security/sanitizer.ts` | PCI-DSS veri maskeleme ilkeleri, Data Minimization |
| Girdi şema doğrulama | `presentation/mcp/tool-registry.ts`, `config/env.schema.ts` | OWASP API Security Top 10 (API8, API3) |
| Token yaşam döngüsü yönetimi | `oauth-bank-adapter.base.ts` | OWASP API Security (Credential Exposure önleme) |
| Correlation ID + Structured Logging | `infrastructure/observability/logger.ts` | Audit Trail / İzlenebilirlik gereksinimleri |
| Audit Event Kaydı (tool, outcome, duration) | `logger.ts` — `audit()` metodu | Operasyonel Risk Kontrolü |
| Circuit Breaker + Retry + Timeout | `infrastructure/resilience.ts` | Operasyonel Dayanıklılık, SLO Koruması |
| Erken konfigürasyon doğrulama (fail-fast) | `config/env.schema.ts` | Operasyonel Risk Azaltımı |

## 5. Uygunluk Notu (Disclaimer)
Bu doküman, bir referans mimariyi ve tasarım kararlarının gerekçelerini açıklar. Burada atıfta bulunulan standartlar (PSD2, PCI-DSS, OWASP API Security) tasarım kararlarını yönlendiren referans çerçeveler olarak kullanılmıştır.
