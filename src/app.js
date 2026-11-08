'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { hashPassword, verifyPassword, transaction } = require('./db');
const {
  isValidTime, isValidDate, mondayOf, studentConflict, teacherConflict, weekSchedule,
} = require('./schedule');

const COOKIE = 'tok';
const TOKEN_DAYS = 30;
const MAX_FILE_MB = 25;
const TIME_ZONE = process.env.APP_TZ || 'Europe/Istanbul';

// SQLite'ta tarihten haftanın gününü (1 = Pazartesi ... 7 = Pazar) hesaplar.
const SQL_WEEKDAY = "((CAST(strftime('%w', s.date) AS INTEGER) + 6) % 7) + 1";

function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(new Date());
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => { throw new HttpError(status, message); };

function text(value, label, max = 100) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) fail(`${label} boş olamaz.`);
  if (v.length > max) fail(`${label} en fazla ${max} karakter olabilir.`);
  return v;
}

function id(value, label = 'Kayıt') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${label} geçersiz.`);
  return n;
}

function timeRange(start, end) {
  if (!isValidTime(start) || !isValidTime(end)) fail('Saatleri SS:DD biçiminde girin.');
  if (start >= end) fail('Bitiş saati başlangıçtan sonra olmalı.');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, username: u.username, class_id: u.class_id ?? null });

function createApp({ db, uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      next(err);
    }
  };

  // ---------- Oturum ----------
  function auth(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const row = token && db.prepare(`
      SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = ? AND t.created_at > datetime('now', ?)`).get(token, `-${TOKEN_DAYS} days`);
    if (!row) return next(new HttpError(401, 'Lütfen giriş yapın.'));
    req.user = row;
    req.token = token;
    next();
  }
  const role = (...roles) => (req, res, next) =>
    (roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Bu işlem için yetkiniz yok.')));

  app.post('/api/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      fail('Kullanıcı adı veya şifre hatalı.', 401);
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare("DELETE FROM tokens WHERE created_at <= datetime('now', ?)").run(`-${TOKEN_DAYS} days`);
    db.prepare("INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, datetime('now'))").run(token, user.id);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TOKEN_DAYS * 86400}${secure}`);
    return publicUser(user);
  }));

  app.post('/api/logout', auth, wrap((req, res) => {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  }));

  app.get('/api/me', auth, wrap((req) => {
    const me = publicUser(req.user);
    if (me.class_id) me.class_name = db.prepare('SELECT name FROM classes WHERE id = ?').get(me.class_id)?.name;
    return me;
  }));

  app.post('/api/me/password', auth, wrap((req) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), req.user.password_hash)) fail('Mevcut şifre hatalı.');
    if (typeof next !== 'string' || next.length < 6) fail('Yeni şifre en az 6 karakter olmalı.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
    return { ok: true };
  }));

  // ---------- Ders programı (öğrenci ve öğretmen) ----------
  app.get('/api/schedule', auth, role('student', 'teacher'), wrap((req) => {
    const week = isValidDate(req.query.week) ? req.query.week : today();
    const monday = mondayOf(week);
    const who = req.user.role === 'student' ? { studentId: req.user.id } : { teacherId: req.user.id };
    return { monday, today: today(), days: weekSchedule(db, who, monday) };
  }));

  // ---------- Dosyalar ----------
  app.get('/api/files', auth, role('student', 'teacher'), wrap((req) => {
    const base = `
      SELECT f.id, f.title, f.original_name, f.size, f.created_at,
             t.name AS teacher_name, c.name AS class_name, s.name AS student_name
      FROM files f
      JOIN users t ON t.id = f.teacher_id
      LEFT JOIN classes c ON c.id = f.class_id
      LEFT JOIN users s ON s.id = f.student_id`;
    if (req.user.role === 'teacher') {
      return db.prepare(`${base} WHERE f.teacher_id = ? ORDER BY f.id DESC`).all(req.user.id);
    }
    return db.prepare(`${base} WHERE f.student_id = ? OR (f.class_id IS NOT NULL AND f.class_id = ?)
      ORDER BY f.id DESC`).all(req.user.id, req.user.class_id ?? -1);
  }));

  app.get('/api/files/:id/download', auth, (req, res, next) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    const u = req.user;
    const allowed = file && (
      u.role === 'admin'
      || (u.role === 'teacher' && file.teacher_id === u.id)
      || (u.role === 'student' && (file.student_id === u.id || (file.class_id && file.class_id === u.class_id)))
    );
    if (!allowed) return next(new HttpError(404, 'Dosya bulunamadı.'));
    res.download(path.join(uploadDir, file.stored_name), file.original_name);
  });

  function removeStoredFiles(rows) {
    for (const r of rows) fs.rm(path.join(uploadDir, r.stored_name), { force: true }, () => {});
  }

  // ---------- Yönetici ----------
  const admin = [auth, role('admin')];

  app.get('/api/admin/overview', ...admin, wrap(() => ({
    classes: db.prepare(`
      SELECT c.id, c.name,
        (SELECT count(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS student_count,
        (SELECT count(*) FROM class_lessons l WHERE l.class_id = c.id) AS lesson_count
      FROM classes c ORDER BY c.name`).all(),
    teachers: db.prepare(`
      SELECT u.id, u.name, u.username,
        (SELECT group_concat(x, ', ') FROM (
           SELECT DISTINCT c.name || ' ' || l.subject AS x FROM class_lessons l
           JOIN classes c ON c.id = l.class_id WHERE l.teacher_id = u.id ORDER BY c.name)) AS classes
      FROM users u WHERE u.role = 'teacher' ORDER BY u.name`).all(),
    students: db.prepare(`
      SELECT u.id, u.name, u.username, u.class_id, c.name AS class_name
      FROM users u LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.role = 'student' ORDER BY u.name`).all(),
  })));

  app.post('/api/admin/classes', ...admin, wrap((req) => {
    const name = text(req.body?.name, 'Sınıf adı', 40);
    if (db.prepare('SELECT 1 FROM classes WHERE name = ?').get(name)) fail('Bu isimde bir sınıf zaten var.');
    const r = db.prepare('INSERT INTO classes (name) VALUES (?)').run(name);
    return { id: Number(r.lastInsertRowid), name };
  }));

  app.get('/api/admin/classes/:id', ...admin, wrap((req) => {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(req.params.id));
    if (!cls) fail('Sınıf bulunamadı.', 404);
    cls.students = db.prepare("SELECT id, name FROM users WHERE role = 'student' AND class_id = ? ORDER BY name").all(cls.id);
    cls.lessons = db.prepare(`
      SELECT l.id, l.subject, l.day, l.start_time, l.end_time, l.teacher_id, t.name AS teacher_name
      FROM class_lessons l JOIN users t ON t.id = l.teacher_id
      WHERE l.class_id = ? ORDER BY l.day, l.start_time`).all(cls.id);
    return cls;
  }));

  app.delete('/api/admin/classes/:id', ...admin, wrap((req) => {
    const classId = Number(req.params.id);
    const files = db.prepare('SELECT stored_name FROM files WHERE class_id = ?').all(classId);
    db.prepare('DELETE FROM classes WHERE id = ?').run(classId);
    removeStoredFiles(files);
    return { ok: true };
  }));

  app.post('/api/admin/users', ...admin, wrap((req) => {
    const b = req.body || {};
    if (!['teacher', 'student'].includes(b.role)) fail('Rol geçersiz.');
    const name = text(b.name, 'Ad soyad', 80);
    const username = text(b.username, 'Kullanıcı adı', 40);
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail('Kullanıcı adında sadece harf, rakam, nokta, tire kullanın (Türkçe karakter olmadan).');
    if (typeof b.password !== 'string' || b.password.length < 6) fail('Şifre en az 6 karakter olmalı.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail('Bu kullanıcı adı alınmış.');
    let classId = null;
    if (b.role === 'student' && b.class_id) {
      classId = id(b.class_id, 'Sınıf');
      if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) fail('Sınıf bulunamadı.');
    }
    const r = db.prepare('INSERT INTO users (role, name, username, password_hash, class_id) VALUES (?, ?, ?, ?, ?)')
      .run(b.role, name, username, hashPassword(b.password), classId);
    return { id: Number(r.lastInsertRowid) };
  }));

  app.patch('/api/admin/users/:id', ...admin, wrap((req) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role <> 'admin'").get(Number(req.params.id));
    if (!user) fail('Kullanıcı bulunamadı.', 404);
    const b = req.body || {};
    if ('class_id' in b) {
      if (user.role !== 'student') fail('Sadece öğrencilerin sınıfı değiştirilebilir.');
      const classId = b.class_id ? id(b.class_id, 'Sınıf') : null;
      if (classId) {
        if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) fail('Sınıf bulunamadı.');
        // Öğrencinin ileri tarihli özel ders/etütleri yeni sınıfın dersleriyle çakışıyor mu?
        const clash = db.prepare(`
          SELECT s.date, s.start_time, s.end_time, l.subject FROM sessions s
          JOIN session_students ss ON ss.session_id = s.id
          JOIN class_lessons l ON l.class_id = ? AND l.day = ${SQL_WEEKDAY}
            AND l.start_time < s.end_time AND s.start_time < l.end_time
          WHERE ss.student_id = ? AND s.date >= ? LIMIT 1`).get(classId, user.id, today());
        if (clash) {
          fail(`Öğrencinin ${clash.date} ${clash.start_time}-${clash.end_time} özel ders/etüdü, yeni sınıfın ${clash.subject} dersiyle çakışıyor.`);
        }
      }
      db.prepare('UPDATE users SET class_id = ? WHERE id = ?').run(classId, user.id);
    }
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 6) fail('Şifre en az 6 karakter olmalı.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), user.id);
      db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id);
    }
    return { ok: true };
  }));

  app.delete('/api/admin/users/:id', ...admin, wrap((req) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role <> 'admin'").get(Number(req.params.id));
    if (!user) fail('Kullanıcı bulunamadı.', 404);
    const files = db.prepare('SELECT stored_name FROM files WHERE teacher_id = ? OR student_id = ?').all(user.id, user.id);
    transaction(db, () => {
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      // Öğrencisi kalmayan özel ders/etütleri temizle
      db.prepare('DELETE FROM sessions WHERE id NOT IN (SELECT session_id FROM session_students)').run();
    });
    removeStoredFiles(files);
    return { ok: true };
  }));

  app.post('/api/admin/lessons', ...admin, wrap((req) => {
    const b = req.body || {};
    const classId = id(b.class_id, 'Sınıf');
    const teacherId = id(b.teacher_id, 'Öğretmen');
    const subject = text(b.subject, 'Ders adı', 60);
    const day = Number(b.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) fail('Gün geçersiz.');
    timeRange(b.start, b.end);
    if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) fail('Sınıf bulunamadı.');
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'teacher'").get(teacherId)) fail('Öğretmen bulunamadı.');

    const c1 = db.prepare(`
      SELECT subject, start_time, end_time FROM class_lessons
      WHERE class_id = ? AND day = ? AND start_time < ? AND ? < end_time`).get(classId, day, b.end, b.start);
    if (c1) fail(`Sınıfın bu saatte dersi var: ${c1.subject} ${c1.start_time}-${c1.end_time}`);
    const c2 = db.prepare(`
      SELECT l.subject, l.start_time, l.end_time, c.name FROM class_lessons l JOIN classes c ON c.id = l.class_id
      WHERE l.teacher_id = ? AND l.day = ? AND l.start_time < ? AND ? < l.end_time`).get(teacherId, day, b.end, b.start);
    if (c2) fail(`Öğretmenin bu saatte ${c2.name} sınıfında dersi var (${c2.start_time}-${c2.end_time}).`);

    // İleri tarihli özel ders/etütlerle çakışma (öğretmenin veya sınıftaki öğrencilerin)
    const c3 = db.prepare(`
      SELECT s.date, s.start_time, s.end_time FROM sessions s
      WHERE s.date >= ? AND ${SQL_WEEKDAY} = ? AND s.start_time < ? AND ? < s.end_time
        AND (s.teacher_id = ? OR EXISTS (
          SELECT 1 FROM session_students ss JOIN users u ON u.id = ss.student_id
          WHERE ss.session_id = s.id AND u.class_id = ?))
      LIMIT 1`).get(today(), day, b.end, b.start, teacherId, classId);
    if (c3) fail(`Bu saat, ${c3.date} tarihli bir özel ders/etütle çakışıyor (${c3.start_time}-${c3.end_time}).`);

    const r = db.prepare(`INSERT INTO class_lessons (class_id, teacher_id, subject, day, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?)`).run(classId, teacherId, subject, day, b.start, b.end);
    return { id: Number(r.lastInsertRowid) };
  }));

  app.delete('/api/admin/lessons/:id', ...admin, wrap((req) => {
    db.prepare('DELETE FROM class_lessons WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  }));

  // ---------- Öğretmen ----------
  const teacher = [auth, role('teacher')];

  app.get('/api/teacher/classes', ...teacher, wrap((req) => db.prepare(`
    SELECT DISTINCT c.id, c.name FROM class_lessons l JOIN classes c ON c.id = l.class_id
    WHERE l.teacher_id = ? ORDER BY c.name`).all(req.user.id)));

  // Tüm öğrenciler; tarih ve saat verilirse her öğrencinin o aralıkta boş olup olmadığı da döner.
  app.get('/api/teacher/students', ...teacher, wrap((req) => {
    const { date, start, end } = req.query;
    const students = db.prepare(`
      SELECT u.id, u.name, c.name AS class_name FROM users u LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.role = 'student' ORDER BY u.name`).all();
    if (!date && !start && !end) return { students };
    if (!isValidDate(date)) fail('Tarih geçersiz.');
    timeRange(start, end);
    for (const s of students) s.busy = studentConflict(db, s.id, date, start, end);
    return { teacher_busy: teacherConflict(db, req.user.id, date, start, end), students };
  }));

  app.post('/api/teacher/sessions', ...teacher, wrap((req) => {
    const b = req.body || {};
    if (!['ozel', 'etut'].includes(b.kind)) fail('Tür geçersiz.');
    if (!isValidDate(b.date)) fail('Tarih geçersiz.');
    if (b.date < today()) fail('Geçmiş bir tarihe ekleme yapılamaz.');
    timeRange(b.start, b.end);
    const subject = text(b.subject, 'Ders/konu', 60);
    const ids = [...new Set((Array.isArray(b.student_ids) ? b.student_ids : []).map((x) => id(x, 'Öğrenci')))];
    if (ids.length === 0) fail('En az bir öğrenci seçin.');
    if (b.kind === 'ozel' && ids.length > 1) fail('Özel ders tek öğrenciyle yapılır. Birden fazla öğrenci için Etüt seçin.');

    return transaction(db, () => {
      const busy = teacherConflict(db, req.user.id, b.date, b.start, b.end);
      if (busy) fail(`Bu saatte siz doluyken ekleyemezsiniz (${busy}).`);
      for (const sid of ids) {
        const st = db.prepare("SELECT name FROM users WHERE id = ? AND role = 'student'").get(sid);
        if (!st) fail('Öğrenci bulunamadı.');
        const why = studentConflict(db, sid, b.date, b.start, b.end);
        if (why) fail(`${st.name} bu saatte dolu (${why}).`);
      }
      const r = db.prepare(`INSERT INTO sessions (teacher_id, kind, subject, date, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, b.kind, subject, b.date, b.start, b.end);
      const sessionId = Number(r.lastInsertRowid);
      const add = db.prepare('INSERT INTO session_students (session_id, student_id) VALUES (?, ?)');
      for (const sid of ids) add.run(sessionId, sid);
      return { id: sessionId };
    });
  }));

  app.delete('/api/teacher/sessions/:id', ...teacher, wrap((req) => {
    const r = db.prepare('DELETE FROM sessions WHERE id = ? AND teacher_id = ?').run(Number(req.params.id), req.user.id);
    if (r.changes === 0) fail('Kayıt bulunamadı.', 404);
    return { ok: true };
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
      },
    }),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  });

  app.post('/api/teacher/files', ...teacher, upload.single('file'), wrap((req) => {
    try {
      if (!req.file) fail('Dosya seçin.');
      const b = req.body || {};
      const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const title = (typeof b.title === 'string' && b.title.trim()) ? text(b.title, 'Başlık', 100) : originalName;
      let classId = null;
      let studentId = null;
      if (b.target === 'class') {
        classId = id(b.target_id, 'Sınıf');
        const teaches = db.prepare('SELECT 1 FROM class_lessons WHERE class_id = ? AND teacher_id = ?').get(classId, req.user.id);
        if (!teaches) fail('Sadece ders verdiğiniz sınıflara dosya yükleyebilirsiniz.');
      } else if (b.target === 'student') {
        studentId = id(b.target_id, 'Öğrenci');
        if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'student'").get(studentId)) fail('Öğrenci bulunamadı.');
      } else {
        fail('Dosyanın kime gönderileceğini seçin.');
      }
      const r = db.prepare(`INSERT INTO files (teacher_id, class_id, student_id, title, original_name, stored_name, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(req.user.id, classId, studentId, title, originalName, req.file.filename, req.file.size);
      return { id: Number(r.lastInsertRowid) };
    } catch (err) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      throw err;
    }
  }));

  app.delete('/api/teacher/files/:id', ...teacher, wrap((req) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND teacher_id = ?').get(Number(req.params.id), req.user.id);
    if (!file) fail('Dosya bulunamadı.', 404);
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    removeStoredFiles([file]);
    return { ok: true };
  }));

  // ---------- Statik arayüz ----------
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Bulunamadı.')));
  app.use(express.static(path.join(__dirname, '..', 'docs')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err instanceof multer.MulterError) {
      status = 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? `Dosya en fazla ${MAX_FILE_MB} MB olabilir.` : 'Dosya yüklenemedi.';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Geçersiz istek.';
    } else if (status >= 500) {
      console.error(err);
      message = 'Sunucu hatası.';
    }
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp, today };
