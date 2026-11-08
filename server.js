'use strict';
const fs = require('fs');
const path = require('path');
const { openDb, hashPassword } = require('./src/db');
const { createApp } = require('./src/app');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'app.db'));

// İlk çalıştırmada bir yönetici hesabı oluştur.
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("INSERT INTO users (role, name, username, password_hash) VALUES ('admin', 'Yönetici', 'admin', ?)")
    .run(hashPassword(password));
  console.log(`Yönetici hesabı oluşturuldu -> kullanıcı adı: admin, şifre: ${password} (giriş yapıp değiştirin)`);
}

const app = createApp({ db, uploadDir: path.join(DATA_DIR, 'uploads') });
app.listen(PORT, () => console.log(`Uygulama çalışıyor: http://localhost:${PORT}`));
