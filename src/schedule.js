'use strict';

// Tarih ve saatler metin olarak tutulur: tarih "YYYY-AA-GG", saat "SS:DD".
// Sıfır dolgulu oldukları için metin karşılaştırması sıralamayla aynıdır.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KIND_LABELS = { ders: 'Ders', ozel: 'Özel Ders', etut: 'Etüt' };

function isValidTime(t) {
  return typeof t === 'string' && TIME_RE.test(t);
}

function isValidDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

/** 1 = Pazartesi ... 7 = Pazar */
function weekdayOf(date) {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(date) {
  return addDays(date, 1 - weekdayOf(date));
}

function describe(row) {
  return `${KIND_LABELS[row.kind] || 'Ders'}: ${row.subject} ${row.start_time}-${row.end_time}`;
}

/** Öğrencinin verilen tarih/saat aralığında meşgul olup olmadığını döndürür (sebep metni veya null). */
function studentConflict(db, studentId, date, start, end) {
  const lesson = db.prepare(`
    SELECT 'ders' AS kind, cl.subject, cl.start_time, cl.end_time
    FROM class_lessons cl JOIN users u ON u.class_id = cl.class_id
    WHERE u.id = ? AND cl.day = ? AND cl.start_time < ? AND ? < cl.end_time
    ORDER BY cl.start_time LIMIT 1`).get(studentId, weekdayOf(date), end, start);
  if (lesson) return describe(lesson);

  const session = db.prepare(`
    SELECT s.kind, s.subject, s.start_time, s.end_time
    FROM sessions s JOIN session_students ss ON ss.session_id = s.id
    WHERE ss.student_id = ? AND s.date = ? AND s.start_time < ? AND ? < s.end_time
    ORDER BY s.start_time LIMIT 1`).get(studentId, date, end, start);
  return session ? describe(session) : null;
}

/** Öğretmenin verilen tarih/saat aralığında meşgul olup olmadığını döndürür (sebep metni veya null). */
function teacherConflict(db, teacherId, date, start, end) {
  const lesson = db.prepare(`
    SELECT 'ders' AS kind, subject, start_time, end_time FROM class_lessons
    WHERE teacher_id = ? AND day = ? AND start_time < ? AND ? < end_time
    ORDER BY start_time LIMIT 1`).get(teacherId, weekdayOf(date), end, start);
  if (lesson) return describe(lesson);

  const session = db.prepare(`
    SELECT kind, subject, start_time, end_time FROM sessions
    WHERE teacher_id = ? AND date = ? AND start_time < ? AND ? < end_time
    ORDER BY start_time LIMIT 1`).get(teacherId, date, end, start);
  return session ? describe(session) : null;
}

/**
 * Bir haftalık programı döndürür. who = { studentId } veya { teacherId }.
 * Haftalık sınıf dersleri ile o haftaya düşen özel ders/etütler birleştirilir.
 */
function weekSchedule(db, who, monday) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push({ date: addDays(monday, i), day: i + 1, items: [] });
  const sunday = days[6].date;

  let lessons;
  let sessions;
  if (who.studentId) {
    lessons = db.prepare(`
      SELECT cl.id, cl.day, cl.subject, cl.start_time, cl.end_time, t.name AS who
      FROM class_lessons cl
      JOIN users s ON s.class_id = cl.class_id
      JOIN users t ON t.id = cl.teacher_id
      WHERE s.id = ?`).all(who.studentId);
    sessions = db.prepare(`
      SELECT s.id, s.kind, s.date, s.subject, s.start_time, s.end_time, t.name AS who
      FROM sessions s
      JOIN session_students ss ON ss.session_id = s.id
      JOIN users t ON t.id = s.teacher_id
      WHERE ss.student_id = ? AND s.date BETWEEN ? AND ?`).all(who.studentId, monday, sunday);
  } else {
    lessons = db.prepare(`
      SELECT cl.id, cl.day, cl.subject, cl.start_time, cl.end_time, c.name AS who
      FROM class_lessons cl JOIN classes c ON c.id = cl.class_id
      WHERE cl.teacher_id = ?`).all(who.teacherId);
    sessions = db.prepare(`
      SELECT s.id, s.kind, s.date, s.subject, s.start_time, s.end_time,
             (SELECT group_concat(u.name, ', ') FROM session_students ss
              JOIN users u ON u.id = ss.student_id WHERE ss.session_id = s.id) AS who
      FROM sessions s
      WHERE s.teacher_id = ? AND s.date BETWEEN ? AND ?`).all(who.teacherId, monday, sunday);
  }

  for (const l of lessons) {
    days[l.day - 1].items.push({
      kind: 'ders', id: l.id, subject: l.subject, start: l.start_time, end: l.end_time, who: l.who,
    });
  }
  for (const s of sessions) {
    days[weekdayOf(s.date) - 1].items.push({
      kind: s.kind, id: s.id, subject: s.subject, start: s.start_time, end: s.end_time, who: s.who || '',
    });
  }
  for (const d of days) d.items.sort((a, b) => a.start.localeCompare(b.start));
  return days;
}

module.exports = {
  isValidTime, isValidDate, weekdayOf, addDays, mondayOf,
  studentConflict, teacherConflict, weekSchedule, KIND_LABELS,
};
