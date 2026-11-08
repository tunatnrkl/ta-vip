# TA VIP – Dershane Uygulaması

Telefonda uygulama gibi çalışan, sade bir dershane sistemi. Tarayıcıdan açılır,
"Ana ekrana ekle" ile telefona uygulama olarak kurulabilir.

## Kim ne yapar?

**Yönetici**
- Sınıf, öğretmen ve öğrenci hesaplarını oluşturur.
- Öğrencinin hangi sınıfta olacağını belirler (Öğrenciler sekmesi veya sınıf sayfası).
- Öğretmenin hangi sınıfa ders vereceğini belirler: Sınıflar → sınıf → **Ders ekle** (öğretmen, ders, gün, saat).
  Bu haftalık ders hem sınıftaki öğrencilerin hem öğretmenin programına yansır.

**Öğretmen**
- **Ders Ekle:** Özel ders (1 öğrenci) veya etüt (grup) ekler. Tarih ve saati seçince
  sistem o saatte boş olan öğrencileri gösterir. Dolu olanlar nedeniyle birlikte soluk görünür ve seçilemez.
  Kaydedilen ders öğrencinin programına otomatik düşer.
- **Dosyalar:** Ders verdiği bir sınıfa veya tek bir öğrenciye dosya yükler.
- **Programım:** Kendi haftalık programı. Eklediği özel ders ve etütleri buradan silebilir.

**Öğrenci**
- **Programım:** Sınıf dersleri, özel dersler ve etütler tek haftalık görünümde.
- **Dosyalar:** Sınıfına ve kendisine yüklenen dosyalar.

Çakışma kontrolleri: Aynı saate bir öğrenciye veya öğretmene iki ders eklenemez.
Bu kural sınıf dersleri, özel dersler ve etütler için birlikte geçerlidir.

## Çalıştırma

Gereken: Node.js 22.13 veya üstü (veritabanı için Node'un yerleşik SQLite'ı kullanılır, ayrıca kurulum gerekmez).

```bash
npm install
```

```bash
npm start
```

Uygulama `http://localhost:3000` adresinde açılır. İlk çalıştırmada bir yönetici hesabı oluşturulur:
kullanıcı adı `admin`, şifre `admin123`. Giriş yapınca Profil sekmesinden şifreyi değiştirin.
İlk şifreyi `ADMIN_PASSWORD` ortam değişkeniyle de verebilirsiniz.

Denemek için örnek veri yüklemek isterseniz (şifreler `123456`):

```bash
npm run demo
```

Öğretmenler: `ayse`, `mehmet`, `elif`. Öğrenciler: `ali`, `zeynep`, `can`, `deniz`, `ece`.

Testler:

```bash
npm test
```

## Ayarlar

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Sunucu portu |
| `DATA_DIR` | `./data` | Veritabanı (`app.db`) ve yüklenen dosyaların klasörü |
| `ADMIN_PASSWORD` | `admin123` | İlk yönetici şifresi (sadece ilk çalıştırmada) |
| `APP_TZ` | `Europe/Istanbul` | "Bugün" hesabı için saat dilimi |

Yedek almak için `data/` klasörünü kopyalamanız yeterlidir.
Telefonlardan erişim ve "ana ekrana ekle" için sunucuyu HTTPS ile yayınlayın.
