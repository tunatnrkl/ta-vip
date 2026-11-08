'use strict';
// Denemek için örnek sınıf, öğretmen, öğrenci ve ders programı ekler.
// Kullanım: npm run demo   (tüm demo hesaplarının şifresi: 123456)
const fs = require('fs');
const path = require('path');
const { openDb, hashPassword } = require('../src/db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'app.db'));

if (db.prepare("SELECT 1 FROM users WHERE username = 'ayse'").get()) {
  console.log('Demo verisi zaten eklenmiş.');
  process.exit(0);
}

const pw = hashPassword('123456');
const addClass = (name) => Number(db.prepare('INSERT INTO classes (name) VALUES (?)').run(name).lastInsertRowid);
const addUser = (role, name, username, classId = null) => Number(db.prepare(
  'INSERT INTO users (role, name, username, password_hash, class_id) VALUES (?, ?, ?, ?, ?)',
).run(role, name, username, pw, classId).lastInsertRowid);
const lesson = (classId, teacherId, subject, day, start, end) => db.prepare(
  'INSERT INTO class_lessons (class_id, teacher_id, subject, day, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)',
).run(classId, teacherId, subject, day, start, end);

const c12 = addClass('12-A');
const c11 = addClass('11-B');
const lgs = addClass('LGS-1');

const ayse = addUser('teacher', 'Ayşe Yılmaz', 'ayse');
const mehmet = addUser('teacher', 'Mehmet Kaya', 'mehmet');
const elif = addUser('teacher', 'Elif Demir', 'elif');

addUser('student', 'Ali Çelik', 'ali', c12);
addUser('student', 'Zeynep Arslan', 'zeynep', c12);
addUser('student', 'Can Öztürk', 'can', c11);
addUser('student', 'Deniz Şahin', 'deniz', c11);
addUser('student', 'Ece Koç', 'ece', lgs);

// Haftalık sınıf dersleri (1 = Pazartesi)
for (const day of [1, 3, 5]) {
  lesson(c12, ayse, 'Matematik', day, '09:00', '09:40');
  lesson(c12, mehmet, 'Fizik', day, '09:50', '10:30');
  lesson(c11, mehmet, 'Fizik', day, '09:00', '09:40');
  lesson(c11, ayse, 'Matematik', day, '09:50', '10:30');
}
for (const day of [2, 4]) {
  lesson(lgs, elif, 'Türkçe', day, '14:00', '14:40');
  lesson(lgs, ayse, 'Matematik', day, '14:50', '15:30');
  lesson(c12, elif, 'Edebiyat', day, '10:00', '10:40');
}
lesson(c12, ayse, 'TYT Deneme', 6, '10:00', '12:45');

console.log('Demo verisi eklendi. Şifre hepsi için: 123456');
console.log('Öğretmenler: ayse, mehmet, elif  |  Öğrenciler: ali, zeynep, can, deniz, ece');
