'use strict';
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS classes (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  class_id      INTEGER REFERENCES classes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- Yöneticinin belirlediği haftalık sınıf dersleri (öğretmen <-> sınıf ataması)
CREATE TABLE IF NOT EXISTS class_lessons (
  id         INTEGER PRIMARY KEY,
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL
);

-- Öğretmenin eklediği özel ders / etüt (belirli bir tarihte)
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('ozel', 'etut')),
  subject    TEXT NOT NULL,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_students (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, student_id)
);

-- Öğretmenin sınıfa veya öğrenciye yüklediği dosyalar
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  student_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK ((class_id IS NULL) <> (student_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_lessons_class   ON class_lessons(class_id, day);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON class_lessons(teacher_id, day);
CREATE INDEX IF NOT EXISTS idx_sessions_date   ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_ss_student      ON session_students(student_id);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, hashPassword, verifyPassword, transaction };
