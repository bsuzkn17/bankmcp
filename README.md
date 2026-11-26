# Banking MCP Gateway

Banking MCP Gateway, Türk bankacılığı için salt okunur hesap bilgisi entegrasyonlarını araştırmak ve geliştirmek üzere hazırlanmış bir referans mimari/öğrenme prototipidir. `OnurByte/TurkishBankMCP` çalışmasından türetilmiştir ve kaynak atfını korur.

## Önemli kapsam ve uyumluluk notu

Bu proje lisanslı veya yetkilendirilmiş bir AISP değildir ve tek başına gerçek banka hesaplarına erişim yetkisi vermez. KVKK ve 5411 sayılı Kanun bakımından "uyumlu" veya "sertifikalı" olduğu iddia edilmez; mimari, ilgili ilkelerle hizalı ve uyumu destekleyecek şekilde tasarlandı. Gerçek kullanımdan önce gerekli izinler, sözleşmeler, güvenlik kontrolleri ve mevzuat değerlendirmeleri ayrıca tamamlanmalıdır.

Entegrasyon salt okunur hesap bilgisi kapsamındadır. Para transferi, ödeme başlatma veya kart yönetimi işlevleri sunulmaz.

## Geliştirme

Node.js 22 ve npm kullanarak bağımlılıkları yükleyip doğrulayın:

```sh
npm ci
npm run check
```

`npm run check`, TypeScript tür denetimini, testleri ve üretim derlemesini çalıştırır. Test kapsamı için `npm run test:coverage` kullanılabilir.

## Banka ve mock yapılandırması

`ENABLE_MOCK_BANKS=true`, Garanti adaptöründe yerleşik örnek hesap ve işlem verilerini kullanır. `false` olduğunda, istemci kimliği ve sırrı da yapılandırılmışsa adaptör banka API'sine gerçek istekler yapabilir; kimlik bilgilerinden biri boşsa adaptör mock modunda kalır. Mock verileri gerçek müşteri verisi değildir.

`BANK_GARANTI_CLIENT_SECRET_FILE`, sırrı ortam değişkeninde tutmak yerine dosyadan yüklemek için kullanılabilir. Dosya yolunu repo dışındaki bir secret mount'una (örneğin `/run/secrets/bank-garanti-client-secret`) yönlendirin; secret dosyasını depoya eklemeyin. Dolu bir `BANK_GARANTI_CLIENT_SECRET` inline değeri dosyadaki değere önceliklidir.

Diğer ortam değişkenlerinin şablonu [.env.example](./.env.example) dosyasındadır. Gerçek secret değerlerini bu şablona veya repoya koymayın.

## Atıf ve lisans

Bu proje `OnurByte/TurkishBankMCP` çalışmasından türetilmiştir; türetme atfı korunur. Lisans koşulları için [LICENSE](./LICENSE) dosyasına bakın.
