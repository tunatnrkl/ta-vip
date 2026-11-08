'use strict';
// Sunucusuz (tarayıcı içi) arka ucun testi: aynı iş kuralları sunucudakiyle aynı çalışmalı.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../docs/local-backend.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function memoryFiles() {
  const m = new Map();
  return { put: async (k, v) => { m.set(k, v); }, get: async (k) => m.get(k), delete: async (k) => { m.delete(k); } };
}

const NOW = new Date('2026-11-08T10:00:00Z'); // Pazar
const MON = '2026-11-09';

async function setup() {
  const b = createLocalBackend({ storage: memoryStorage(), files: memoryFiles(), now: () => NOW });
  const call = async (method, url, body) => {
    try { return { status: 200, data: await b.handle(method, url, body) }; } catch (e) { return { status: e.status || 500, data: { error: e.message } }; }
  };
  const login = async (u, p = 'secret1') => { const r = await call('POST', '/api/login', { username: u, password: p }); assert.equal(r.status, 200, u); };
  await login('admin', 'admin123');
  return { b, call, login };
}

test('giriş: yanlış şifre reddedilir, oturum olmadan 401', async () => {
  const { call } = await setup();
  await call('POST', '/api/logout');
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'x' })).status, 401);
});

test('yönetici atar, öğretmen özel ders ekler, öğrenci programında görür', async () => {
  const { call, login } = await setup();
  const mk = (role, name, username, class_id) => call('POST', '/api/admin/users', { role, name, username, password: 'secret1', class_id });

  const c1 = (await call('POST', '/api/admin/classes', { name: '12-A' })).data.id;
  const c2 = (await call('POST', '/api/admin/classes', { name: '11-B' })).data.id;
  const t1 = (await mk('teacher', 'Ayşe Hoca', 'ayse')).data.id;
  const t2 = (await mk('teacher', 'Mehmet Hoca', 'mehmet')).data.id;
  const s1 = (await mk('student', 'Ali', 'ali', c1)).data.id;
  const s2 = (await mk('student', 'Zeynep', 'zeynep', c2)).data.id;
  assert.equal((await mk('student', 'X', 'ALI')).status, 400, 'kullanıcı adı büyük/küçük harf duyarsız tekil');

  const lesson = (class_id, teacher_id, start, end) => call('POST', '/api/admin/lessons', { class_id, teacher_id, subject: 'Matematik', day: 1, start, end });
  assert.equal((await lesson(c1, t1, '09:00', '10:00')).status, 200);
  assert.equal((await lesson(c1, t2, '09:30', '10:30')).status, 400, 'sınıf çakışması');
  assert.equal((await lesson(c2, t1, '09:00', '09:40')).status, 400, 'öğretmen çakışması');

  await login('mehmet');
  const avail = (await call('GET', `/api/teacher/students?date=${MON}&start=09:15&end=09:45`)).data;
  assert.match(avail.students.find((s) => s.id === s1).busy, /Matematik/);
  assert.equal(avail.students.find((s) => s.id === s2).busy, null);

  const body = (o) => ({ kind: 'ozel', subject: 'Fizik', date: MON, start: '09:15', end: '09:45', student_ids: [s2], ...o });
  assert.equal((await call('POST', '/api/teacher/sessions', body({ student_ids: [s1] }))).status, 400, 'dolu öğrenci');
  assert.equal((await call('POST', '/api/teacher/sessions', body({ student_ids: [s1, s2], start: '11:00', end: '12:00' }))).status, 400, 'özel ders tek öğrenci');
  assert.equal((await call('POST', '/api/teacher/sessions', body({ date: '2026-11-07' }))).status, 400, 'geçmiş tarih');
  const ok = await call('POST', '/api/teacher/sessions', body());
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/teacher/sessions', { ...body({ student_ids: [s1, s2], start: '13:00', end: '14:00' }), kind: 'etut' })).status, 200);
  assert.match((await call('GET', `/api/teacher/students?date=${MON}&start=09:30&end=09:40`)).data.teacher_busy, /Özel Ders/);

  await login('zeynep');
  const day = (await call('GET', `/api/schedule?week=${MON}`)).data.days.find((d) => d.date === MON);
  assert.deepEqual(day.items.map((i) => [i.kind, i.start, i.who]), [['ozel', '09:15', 'Mehmet Hoca'], ['etut', '13:00', 'Mehmet Hoca']]);
  assert.equal((await call('GET', '/api/admin/overview')).status, 403);

  await login('ali');
  const aliDay = (await call('GET', `/api/schedule?week=${MON}`)).data.days.find((d) => d.date === MON);
  assert.deepEqual(aliDay.items.map((i) => i.kind), ['ders', 'etut']);

  await login('admin', 'admin123');
  const move = await call('PATCH', `/api/admin/users/${s2}`, { class_id: c1 });
  assert.equal(move.status, 400);
  assert.match(move.data.error, /çakışıyor/);

  await login('mehmet');
  await call('DELETE', `/api/teacher/sessions/${ok.data.id}`);
  await login('zeynep');
  assert.equal((await call('GET', `/api/schedule?week=${MON}`)).data.days.find((d) => d.date === MON).items.length, 1);
});

test('dosyalar: sınıfa ve öğrenciye yüklenir, sadece ilgili öğrenci indirir', async () => {
  const { b, call, login } = await setup();
  const mk = (role, name, username, class_id) => call('POST', '/api/admin/users', { role, name, username, password: 'secret1', class_id });
  const c1 = (await call('POST', '/api/admin/classes', { name: '12-A' })).data.id;
  const c2 = (await call('POST', '/api/admin/classes', { name: '11-B' })).data.id;
  const t = (await mk('teacher', 'Ayşe', 'ayse')).data.id;
  await mk('student', 'Ali', 'ali', c1);
  const z = (await mk('student', 'Zeynep', 'zeynep', c2)).data.id;
  await call('POST', '/api/admin/lessons', { class_id: c1, teacher_id: t, subject: 'Mat', day: 2, start: '09:00', end: '10:00' });

  await login('ayse');
  const send = (target, target_id, name, title = '') => {
    const fd = new FormData();
    fd.append('target', target); fd.append('target_id', String(target_id)); fd.append('title', title);
    fd.append('file', new Blob(['merhaba']), name);
    return call('POST', '/api/teacher/files', fd);
  };
  assert.equal((await send('class', c1, 'föy.pdf', 'Türev föyü')).status, 200);
  assert.equal((await send('student', z, 'özel.pdf')).status, 200);
  assert.equal((await send('class', c2, 'x.pdf')).status, 400, 'ders vermediği sınıf');

  await login('ali');
  const aliFiles = (await call('GET', '/api/files')).data;
  assert.deepEqual(aliFiles.map((f) => f.title), ['Türev föyü']);
  assert.equal(await (await b.download(aliFiles[0].id)).blob.text(), 'merhaba');

  await login('zeynep');
  const zf = (await call('GET', '/api/files')).data;
  assert.deepEqual(zf.map((f) => f.title), ['özel.pdf']);
  await login('ali');
  await assert.rejects(() => b.download(zf[0].id), /bulunamadı/);
});
