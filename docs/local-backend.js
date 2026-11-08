'use strict';
/*
 * Sunucusuz çalışma modu: sunucudaki API'nin aynısını tarayıcının içinde çalıştırır.
 * Veriler bu tarayıcının localStorage'ında, dosyalar IndexedDB'sinde saklanır.
 * (Sunucu varsa uygulama bunu kullanmaz, doğrudan sunucuyla konuşur.)
 */
(function (root) {
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const KIND_LABELS = { ders: 'Ders', ozel: 'Özel Ders', etut: 'Etüt' };
  const MAX_FILE_MB = 10;
  const DATA_KEY = 'tavip.data.v1';
  const SESSION_KEY = 'tavip.session.v1';

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const fail = (message, status = 400) => { throw new HttpError(status, message); };

  // ---------- tarih / saat ----------
  const isValidTime = (t) => typeof t === 'string' && TIME_RE.test(t);
  function isValidDate(d) {
    if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
    const p = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(p.getTime()) && p.toISOString().slice(0, 10) === d;
  }
  const weekdayOf = (date) => { const w = new Date(`${date}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
  const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mondayOf = (date) => addDays(date, 1 - weekdayOf(date));
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

  // ---------- doğrulama ----------
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

  // ---------- şifre ----------
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return toHex(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256));
  }
  const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

  function createLocalBackend({ storage, files, now = () => new Date(), timeZone = 'Europe/Istanbul' }) {
    const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(now());

    // ---------- veri ----------
    let cache = null;
    const emptyData = () => ({ seq: 0, classes: [], users: [], lessons: [], sessions: [], files: [] });
    function load() {
      if (cache) return cache;
      try { cache = JSON.parse(storage.getItem(DATA_KEY)); } catch { cache = null; }
      if (!cache || !Array.isArray(cache.users)) cache = emptyData();
      return cache;
    }
    const save = () => storage.setItem(DATA_KEY, JSON.stringify(cache));
    const nextId = () => { const d = load(); d.seq += 1; return d.seq; };

    async function ensureAdmin() {
      const d = load();
      if (d.users.some((u) => u.role === 'admin')) return;
      const salt = newSalt();
      d.users.push({
        id: nextId(), role: 'admin', name: 'Yönetici', username: 'admin',
        salt, hash: await hashPassword('admin123', salt), class_id: null,
      });
      save();
    }

    const findUser = (uid) => load().users.find((u) => u.id === uid);
    const findClass = (cid) => load().classes.find((c) => c.id === cid);
    const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, username: u.username, class_id: u.class_id ?? null });
    const byName = (a, b) => a.name.localeCompare(b.name, 'tr');
    const currentUserId = () => { const v = Number(storage.getItem(SESSION_KEY)); return Number.isInteger(v) && v > 0 ? v : null; };

    // ---------- çakışma kontrolü ----------
    const describe = (kind, subject, start, end) => `${KIND_LABELS[kind] || 'Ders'}: ${subject} ${start}-${end}`;

    function studentConflict(sid, date, start, end) {
      const d = load();
      const st = findUser(sid);
      const day = weekdayOf(date);
      const lesson = d.lessons
        .filter((l) => st.class_id && l.class_id === st.class_id && l.day === day && overlaps(l.start_time, l.end_time, start, end))
        .sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
      if (lesson) return describe('ders', lesson.subject, lesson.start_time, lesson.end_time);
      const s = d.sessions
        .filter((x) => x.date === date && x.student_ids.includes(sid) && overlaps(x.start_time, x.end_time, start, end))
        .sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
      return s ? describe(s.kind, s.subject, s.start_time, s.end_time) : null;
    }

    function teacherConflict(tid, date, start, end) {
      const d = load();
      const day = weekdayOf(date);
      const lesson = d.lessons
        .filter((l) => l.teacher_id === tid && l.day === day && overlaps(l.start_time, l.end_time, start, end))
        .sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
      if (lesson) return describe('ders', lesson.subject, lesson.start_time, lesson.end_time);
      const s = d.sessions
        .filter((x) => x.teacher_id === tid && x.date === date && overlaps(x.start_time, x.end_time, start, end))
        .sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
      return s ? describe(s.kind, s.subject, s.start_time, s.end_time) : null;
    }

    function weekSchedule(who, monday) {
      const d = load();
      const days = [];
      for (let i = 0; i < 7; i++) days.push({ date: addDays(monday, i), day: i + 1, items: [] });
      const sunday = days[6].date;
      const inWeek = (s) => s.date >= monday && s.date <= sunday;

      if (who.studentId) {
        const st = findUser(who.studentId);
        for (const l of d.lessons.filter((x) => st.class_id && x.class_id === st.class_id)) {
          days[l.day - 1].items.push({ kind: 'ders', id: l.id, subject: l.subject, start: l.start_time, end: l.end_time, who: findUser(l.teacher_id)?.name || '' });
        }
        for (const s of d.sessions.filter((x) => inWeek(x) && x.student_ids.includes(st.id))) {
          days[weekdayOf(s.date) - 1].items.push({ kind: s.kind, id: s.id, subject: s.subject, start: s.start_time, end: s.end_time, who: findUser(s.teacher_id)?.name || '' });
        }
      } else {
        for (const l of d.lessons.filter((x) => x.teacher_id === who.teacherId)) {
          days[l.day - 1].items.push({ kind: 'ders', id: l.id, subject: l.subject, start: l.start_time, end: l.end_time, who: findClass(l.class_id)?.name || '' });
        }
        for (const s of d.sessions.filter((x) => inWeek(x) && x.teacher_id === who.teacherId)) {
          days[weekdayOf(s.date) - 1].items.push({
            kind: s.kind, id: s.id, subject: s.subject, start: s.start_time, end: s.end_time,
            who: s.student_ids.map((sid) => findUser(sid)?.name).filter(Boolean).join(', '),
          });
        }
      }
      for (const day of days) day.items.sort((a, b) => a.start.localeCompare(b.start));
      return days;
    }

    // ---------- yardımcılar ----------
    function removeEmptySessions() {
      const d = load();
      d.sessions = d.sessions.filter((s) => s.student_ids.length > 0);
    }
    async function removeFiles(list) {
      for (const f of list) { try { await files.delete(f.id); } catch { /* yoksay */ } }
    }
    function requireRole(user, ...roles) {
      if (!roles.includes(user.role)) fail('Bu işlem için yetkiniz yok.', 403);
    }

    // ---------- yollar ----------
    const routes = [];
    const route = (method, pattern, handler, { auth = true, roles = null } = {}) => {
      routes.push({ method, re: new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`), handler, auth, roles });
    };

    route('POST', '/login', async ({ body }) => {
      const { username, password } = body || {};
      const user = load().users.find((u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
      if (!user || (await hashPassword(String(password || ''), user.salt)) !== user.hash) fail('Kullanıcı adı veya şifre hatalı.', 401);
      storage.setItem(SESSION_KEY, String(user.id));
      return publicUser(user);
    }, { auth: false });

    route('POST', '/logout', () => { storage.removeItem(SESSION_KEY); return { ok: true }; });

    route('GET', '/me', ({ user }) => {
      const me = publicUser(user);
      if (me.class_id) me.class_name = findClass(me.class_id)?.name;
      return me;
    });

    route('POST', '/me/password', async ({ user, body }) => {
      const { current, next } = body || {};
      if ((await hashPassword(String(current || ''), user.salt)) !== user.hash) fail('Mevcut şifre hatalı.');
      if (typeof next !== 'string' || next.length < 6) fail('Yeni şifre en az 6 karakter olmalı.');
      user.salt = newSalt();
      user.hash = await hashPassword(next, user.salt);
      save();
      return { ok: true };
    });

    route('GET', '/schedule', ({ user, query }) => {
      requireRole(user, 'student', 'teacher');
      const week = isValidDate(query.week) ? query.week : today();
      const monday = mondayOf(week);
      const who = user.role === 'student' ? { studentId: user.id } : { teacherId: user.id };
      return { monday, today: today(), days: weekSchedule(who, monday) };
    });

    route('GET', '/files', ({ user }) => {
      requireRole(user, 'student', 'teacher');
      const d = load();
      const rows = d.files.filter((f) => (user.role === 'teacher'
        ? f.teacher_id === user.id
        : f.student_id === user.id || (f.class_id && f.class_id === user.class_id)));
      return rows.sort((a, b) => b.id - a.id).map((f) => ({
        id: f.id, title: f.title, original_name: f.original_name, size: f.size, created_at: f.created_at,
        teacher_name: findUser(f.teacher_id)?.name || '',
        class_name: f.class_id ? findClass(f.class_id)?.name || null : null,
        student_name: f.student_id ? findUser(f.student_id)?.name || null : null,
      }));
    });

    // ----- yönetici -----
    route('GET', '/admin/overview', ({ user }) => {
      requireRole(user, 'admin');
      const d = load();
      return {
        classes: [...d.classes].sort(byName).map((c) => ({
          id: c.id, name: c.name,
          student_count: d.users.filter((u) => u.role === 'student' && u.class_id === c.id).length,
          lesson_count: d.lessons.filter((l) => l.class_id === c.id).length,
        })),
        teachers: d.users.filter((u) => u.role === 'teacher').sort(byName).map((t) => {
          const set = [...new Set(d.lessons.filter((l) => l.teacher_id === t.id)
            .map((l) => `${findClass(l.class_id)?.name} ${l.subject}`))].sort();
          return { id: t.id, name: t.name, username: t.username, classes: set.length ? set.join(', ') : null };
        }),
        students: d.users.filter((u) => u.role === 'student').sort(byName).map((s) => ({
          id: s.id, name: s.name, username: s.username, class_id: s.class_id, class_name: s.class_id ? findClass(s.class_id)?.name || null : null,
        })),
      };
    });

    route('POST', '/admin/classes', ({ user, body }) => {
      requireRole(user, 'admin');
      const name = text(body?.name, 'Sınıf adı', 40);
      const d = load();
      if (d.classes.some((c) => c.name === name)) fail('Bu isimde bir sınıf zaten var.');
      const cls = { id: nextId(), name };
      d.classes.push(cls);
      save();
      return cls;
    });

    route('GET', '/admin/classes/:id', ({ user, params }) => {
      requireRole(user, 'admin');
      const d = load();
      const cls = findClass(Number(params[0]));
      if (!cls) fail('Sınıf bulunamadı.', 404);
      return {
        ...cls,
        students: d.users.filter((u) => u.role === 'student' && u.class_id === cls.id).sort(byName).map((u) => ({ id: u.id, name: u.name })),
        lessons: d.lessons.filter((l) => l.class_id === cls.id)
          .sort((a, b) => a.day - b.day || a.start_time.localeCompare(b.start_time))
          .map((l) => ({ id: l.id, subject: l.subject, day: l.day, start_time: l.start_time, end_time: l.end_time, teacher_id: l.teacher_id, teacher_name: findUser(l.teacher_id)?.name || '' })),
      };
    });

    route('DELETE', '/admin/classes/:id', async ({ user, params }) => {
      requireRole(user, 'admin');
      const d = load();
      const cid = Number(params[0]);
      const gone = d.files.filter((f) => f.class_id === cid);
      d.classes = d.classes.filter((c) => c.id !== cid);
      d.lessons = d.lessons.filter((l) => l.class_id !== cid);
      d.files = d.files.filter((f) => f.class_id !== cid);
      for (const u of d.users) if (u.class_id === cid) u.class_id = null;
      save();
      await removeFiles(gone);
      return { ok: true };
    });

    route('POST', '/admin/users', async ({ user, body }) => {
      requireRole(user, 'admin');
      const b = body || {};
      if (!['teacher', 'student'].includes(b.role)) fail('Rol geçersiz.');
      const name = text(b.name, 'Ad soyad', 80);
      const username = text(b.username, 'Kullanıcı adı', 40);
      if (!/^[a-zA-Z0-9._-]+$/.test(username)) fail('Kullanıcı adında sadece harf, rakam, nokta, tire kullanın (Türkçe karakter olmadan).');
      if (typeof b.password !== 'string' || b.password.length < 6) fail('Şifre en az 6 karakter olmalı.');
      const d = load();
      if (d.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) fail('Bu kullanıcı adı alınmış.');
      let classId = null;
      if (b.role === 'student' && b.class_id) {
        classId = id(b.class_id, 'Sınıf');
        if (!findClass(classId)) fail('Sınıf bulunamadı.');
      }
      const salt = newSalt();
      const u = { id: nextId(), role: b.role, name, username, salt, hash: await hashPassword(b.password, salt), class_id: classId };
      d.users.push(u);
      save();
      return { id: u.id };
    });

    route('PATCH', '/admin/users/:id', async ({ user, params, body }) => {
      requireRole(user, 'admin');
      const d = load();
      const target = d.users.find((u) => u.id === Number(params[0]) && u.role !== 'admin');
      if (!target) fail('Kullanıcı bulunamadı.', 404);
      const b = body || {};
      if ('class_id' in b) {
        if (target.role !== 'student') fail('Sadece öğrencilerin sınıfı değiştirilebilir.');
        const classId = b.class_id ? id(b.class_id, 'Sınıf') : null;
        if (classId) {
          if (!findClass(classId)) fail('Sınıf bulunamadı.');
          const t = today();
          for (const s of d.sessions.filter((x) => x.date >= t && x.student_ids.includes(target.id))) {
            const l = d.lessons.find((x) => x.class_id === classId && x.day === weekdayOf(s.date) && overlaps(x.start_time, x.end_time, s.start_time, s.end_time));
            if (l) fail(`Öğrencinin ${s.date} ${s.start_time}-${s.end_time} özel ders/etüdü, yeni sınıfın ${l.subject} dersiyle çakışıyor.`);
          }
        }
        target.class_id = classId;
      }
      if (b.password !== undefined) {
        if (typeof b.password !== 'string' || b.password.length < 6) fail('Şifre en az 6 karakter olmalı.');
        target.salt = newSalt();
        target.hash = await hashPassword(b.password, target.salt);
      }
      save();
      return { ok: true };
    });

    route('DELETE', '/admin/users/:id', async ({ user, params }) => {
      requireRole(user, 'admin');
      const d = load();
      const uid = Number(params[0]);
      const target = d.users.find((u) => u.id === uid && u.role !== 'admin');
      if (!target) fail('Kullanıcı bulunamadı.', 404);
      const gone = d.files.filter((f) => f.teacher_id === uid || f.student_id === uid);
      d.users = d.users.filter((u) => u.id !== uid);
      d.lessons = d.lessons.filter((l) => l.teacher_id !== uid);
      d.sessions = d.sessions.filter((s) => s.teacher_id !== uid);
      for (const s of d.sessions) s.student_ids = s.student_ids.filter((x) => x !== uid);
      removeEmptySessions();
      d.files = d.files.filter((f) => f.teacher_id !== uid && f.student_id !== uid);
      save();
      await removeFiles(gone);
      return { ok: true };
    });

    route('POST', '/admin/lessons', ({ user, body }) => {
      requireRole(user, 'admin');
      const b = body || {};
      const classId = id(b.class_id, 'Sınıf');
      const teacherId = id(b.teacher_id, 'Öğretmen');
      const subject = text(b.subject, 'Ders adı', 60);
      const day = Number(b.day);
      if (!Number.isInteger(day) || day < 1 || day > 7) fail('Gün geçersiz.');
      timeRange(b.start, b.end);
      const d = load();
      if (!findClass(classId)) fail('Sınıf bulunamadı.');
      if (!d.users.some((u) => u.id === teacherId && u.role === 'teacher')) fail('Öğretmen bulunamadı.');

      const c1 = d.lessons.find((l) => l.class_id === classId && l.day === day && overlaps(l.start_time, l.end_time, b.start, b.end));
      if (c1) fail(`Sınıfın bu saatte dersi var: ${c1.subject} ${c1.start_time}-${c1.end_time}`);
      const c2 = d.lessons.find((l) => l.teacher_id === teacherId && l.day === day && overlaps(l.start_time, l.end_time, b.start, b.end));
      if (c2) fail(`Öğretmenin bu saatte ${findClass(c2.class_id)?.name} sınıfında dersi var (${c2.start_time}-${c2.end_time}).`);
      const t = today();
      const classStudents = d.users.filter((u) => u.class_id === classId).map((u) => u.id);
      const c3 = d.sessions.find((s) => s.date >= t && weekdayOf(s.date) === day && overlaps(s.start_time, s.end_time, b.start, b.end)
        && (s.teacher_id === teacherId || s.student_ids.some((sid) => classStudents.includes(sid))));
      if (c3) fail(`Bu saat, ${c3.date} tarihli bir özel ders/etütle çakışıyor (${c3.start_time}-${c3.end_time}).`);

      const lesson = { id: nextId(), class_id: classId, teacher_id: teacherId, subject, day, start_time: b.start, end_time: b.end };
      d.lessons.push(lesson);
      save();
      return { id: lesson.id };
    });

    route('DELETE', '/admin/lessons/:id', ({ user, params }) => {
      requireRole(user, 'admin');
      const d = load();
      d.lessons = d.lessons.filter((l) => l.id !== Number(params[0]));
      save();
      return { ok: true };
    });

    // ----- öğretmen -----
    route('GET', '/teacher/classes', ({ user }) => {
      requireRole(user, 'teacher');
      const d = load();
      const ids = [...new Set(d.lessons.filter((l) => l.teacher_id === user.id).map((l) => l.class_id))];
      return ids.map((cid) => findClass(cid)).filter(Boolean).sort(byName).map((c) => ({ id: c.id, name: c.name }));
    });

    route('GET', '/teacher/students', ({ user, query }) => {
      requireRole(user, 'teacher');
      const d = load();
      const students = d.users.filter((u) => u.role === 'student').sort(byName)
        .map((s) => ({ id: s.id, name: s.name, class_name: s.class_id ? findClass(s.class_id)?.name || null : null }));
      const { date, start, end } = query;
      if (!date && !start && !end) return { students };
      if (!isValidDate(date)) fail('Tarih geçersiz.');
      timeRange(start, end);
      for (const s of students) s.busy = studentConflict(s.id, date, start, end);
      return { teacher_busy: teacherConflict(user.id, date, start, end), students };
    });

    route('POST', '/teacher/sessions', ({ user, body }) => {
      requireRole(user, 'teacher');
      const b = body || {};
      if (!['ozel', 'etut'].includes(b.kind)) fail('Tür geçersiz.');
      if (!isValidDate(b.date)) fail('Tarih geçersiz.');
      if (b.date < today()) fail('Geçmiş bir tarihe ekleme yapılamaz.');
      timeRange(b.start, b.end);
      const subject = text(b.subject, 'Ders/konu', 60);
      const ids = [...new Set((Array.isArray(b.student_ids) ? b.student_ids : []).map((x) => id(x, 'Öğrenci')))];
      if (ids.length === 0) fail('En az bir öğrenci seçin.');
      if (b.kind === 'ozel' && ids.length > 1) fail('Özel ders tek öğrenciyle yapılır. Birden fazla öğrenci için Etüt seçin.');

      const busy = teacherConflict(user.id, b.date, b.start, b.end);
      if (busy) fail(`Bu saatte siz doluyken ekleyemezsiniz (${busy}).`);
      for (const sid of ids) {
        const st = findUser(sid);
        if (!st || st.role !== 'student') fail('Öğrenci bulunamadı.');
        const why = studentConflict(sid, b.date, b.start, b.end);
        if (why) fail(`${st.name} bu saatte dolu (${why}).`);
      }
      const s = { id: nextId(), teacher_id: user.id, kind: b.kind, subject, date: b.date, start_time: b.start, end_time: b.end, student_ids: ids };
      load().sessions.push(s);
      save();
      return { id: s.id };
    });

    route('DELETE', '/teacher/sessions/:id', ({ user, params }) => {
      requireRole(user, 'teacher');
      const d = load();
      const before = d.sessions.length;
      d.sessions = d.sessions.filter((s) => !(s.id === Number(params[0]) && s.teacher_id === user.id));
      if (d.sessions.length === before) fail('Kayıt bulunamadı.', 404);
      save();
      return { ok: true };
    });

    route('POST', '/teacher/files', async ({ user, body }) => {
      requireRole(user, 'teacher');
      const get = (k) => (body && typeof body.get === 'function' ? body.get(k) : body?.[k]);
      const file = get('file');
      if (!file || typeof file === 'string') fail('Dosya seçin.');
      if (file.size > MAX_FILE_MB * 1024 * 1024) fail(`Dosya en fazla ${MAX_FILE_MB} MB olabilir.`);
      const titleRaw = get('title');
      const title = (typeof titleRaw === 'string' && titleRaw.trim()) ? text(titleRaw, 'Başlık', 100) : (file.name || 'dosya');
      const d = load();
      let classId = null;
      let studentId = null;
      if (get('target') === 'class') {
        classId = id(get('target_id'), 'Sınıf');
        if (!d.lessons.some((l) => l.class_id === classId && l.teacher_id === user.id)) fail('Sadece ders verdiğiniz sınıflara dosya yükleyebilirsiniz.');
      } else if (get('target') === 'student') {
        studentId = id(get('target_id'), 'Öğrenci');
        if (!d.users.some((u) => u.id === studentId && u.role === 'student')) fail('Öğrenci bulunamadı.');
      } else {
        fail('Dosyanın kime gönderileceğini seçin.');
      }
      const rec = {
        id: nextId(), teacher_id: user.id, class_id: classId, student_id: studentId, title,
        original_name: file.name || 'dosya', size: file.size, created_at: now().toISOString().replace('T', ' ').slice(0, 19),
      };
      await files.put(rec.id, file);
      d.files.push(rec);
      save();
      return { id: rec.id };
    });

    route('DELETE', '/teacher/files/:id', async ({ user, params }) => {
      requireRole(user, 'teacher');
      const d = load();
      const f = d.files.find((x) => x.id === Number(params[0]) && x.teacher_id === user.id);
      if (!f) fail('Dosya bulunamadı.', 404);
      d.files = d.files.filter((x) => x !== f);
      save();
      await removeFiles([f]);
      return { ok: true };
    });

    // ---------- dışarıya açılan arayüz ----------
    async function handle(method, url, body) {
      await ensureAdmin();
      const u = new URL(url, 'http://local');
      const path = u.pathname.replace(/^\/?api/, '').replace(/^\/?/, '/');
      const query = Object.fromEntries(u.searchParams);
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (!m) continue;
        let user = null;
        if (r.auth) {
          user = findUser(currentUserId());
          if (!user) fail('Lütfen giriş yapın.', 401);
        }
        return r.handler({ user, params: m.slice(1), query, body });
      }
      return fail('Bulunamadı.', 404);
    }

    /** Yüklenen bir dosyayı (yetki kontrolüyle) döndürür: { blob, name } */
    async function download(fileId) {
      const user = findUser(currentUserId());
      if (!user) fail('Lütfen giriş yapın.', 401);
      const f = load().files.find((x) => x.id === Number(fileId));
      const allowed = f && (user.role === 'admin'
        || (user.role === 'teacher' && f.teacher_id === user.id)
        || (user.role === 'student' && (f.student_id === user.id || (f.class_id && f.class_id === user.class_id))));
      if (!allowed) fail('Dosya bulunamadı.', 404);
      const blob = await files.get(f.id);
      if (!blob) fail('Dosya bulunamadı.', 404);
      return { blob, name: f.original_name };
    }

    return { handle, download, HttpError };
  }

  // ---------- tarayıcı depolaması ----------
  function browserFiles() {
    const open = () => new Promise((resolve, reject) => {
      const r = indexedDB.open('tavip-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('f');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('f', mode);
        const req = fn(t.objectStore('f'));
        t.oncomplete = () => { db.close(); resolve(req.result); };
        t.onerror = () => { db.close(); reject(t.error); };
        t.onabort = () => { db.close(); reject(t.error || new Error('Depolama hatası')); };
      });
    };
    return {
      put: (fid, blob) => tx('readwrite', (s) => s.put(blob, fid)),
      get: (fid) => tx('readonly', (s) => s.get(fid)),
      delete: (fid) => tx('readwrite', (s) => s.delete(fid)),
    };
  }

  const api = { createLocalBackend, browserFiles, HttpError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalBackend = api;
}(typeof window !== 'undefined' ? window : globalThis));
