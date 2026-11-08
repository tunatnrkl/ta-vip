'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, hashPassword } = require('../src/db');
const { createApp, today } = require('../src/app');
const { addDays, weekdayOf } = require('../src/schedule');

const DAY = weekdayOf(addDays(today(), 7)); // haftanın günü: gelecek haftanın aynı günü
const DATE = addDays(today(), 7);

let server;
let base;
let db;

async function login(username, password = 'secret1') {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (p, { method = 'GET', body, form } = {}) => {
    const headers = { cookie };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${base}${p}`, { method, headers, body: payload });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavip-'));
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (role, name, username, password_hash) VALUES ('admin', 'Yönetici', 'admin', ?)")
    .run(hashPassword('secret1'));
  const app = createApp({ db, uploadDir: path.join(dir, 'uploads') });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('yönetici sınıf, öğretmen, öğrenci ve ders atar; özel ders öğrencinin programına yansır', async () => {
  const admin = await login('admin');

  const c = await admin('/api/admin/classes', { method: 'POST', body: { name: '12-A' } });
  assert.equal(c.status, 200);
  const c2 = await admin('/api/admin/classes', { method: 'POST', body: { name: '11-B' } });

  const mk = (role, name, username, class_id) => admin('/api/admin/users', {
    method: 'POST', body: { role, name, username, password: 'secret1', class_id },
  });
  const t1 = (await mk('teacher', 'Ayşe Hoca', 'ayse')).data.id;
  const t2 = (await mk('teacher', 'Mehmet Hoca', 'mehmet')).data.id;
  const s1 = (await mk('student', 'Ali', 'ali', c.data.id)).data.id;
  const s2 = (await mk('student', 'Zeynep', 'zeynep', c2.data.id)).data.id;
  assert.equal((await mk('student', 'X', 'ali')).status, 400, 'aynı kullanıcı adı reddedilir');

  // Öğretmen ataması = sınıfa haftalık ders eklemek
  const l = await admin('/api/admin/lessons', {
    method: 'POST', body: { class_id: c.data.id, teacher_id: t1, subject: 'Matematik', day: DAY, start: '09:00', end: '10:00' },
  });
  assert.equal(l.status, 200);
  // Aynı sınıfa çakışan ders
  const clashClass = await admin('/api/admin/lessons', {
    method: 'POST', body: { class_id: c.data.id, teacher_id: t2, subject: 'Fizik', day: DAY, start: '09:30', end: '10:30' },
  });
  assert.equal(clashClass.status, 400);
  // Aynı öğretmen aynı saatte başka sınıfta
  const clashTeacher = await admin('/api/admin/lessons', {
    method: 'POST', body: { class_id: c2.data.id, teacher_id: t1, subject: 'Matematik', day: DAY, start: '09:00', end: '09:40' },
  });
  assert.equal(clashTeacher.status, 400);

  // Öğretmen 2 boş öğrencileri görür: Ali 09:00'da derste, Zeynep boş
  const teacher = await login('mehmet');
  const avail = await teacher(`/api/teacher/students?date=${DATE}&start=09:15&end=09:45`);
  assert.equal(avail.status, 200);
  assert.equal(avail.data.teacher_busy, null);
  const ali = avail.data.students.find((s) => s.id === s1);
  const zey = avail.data.students.find((s) => s.id === s2);
  assert.match(ali.busy, /Matematik/);
  assert.equal(zey.busy, null);

  // Dolu öğrenciye ekleme reddedilir
  const bad = await teacher('/api/teacher/sessions', {
    method: 'POST', body: { kind: 'ozel', subject: 'Fizik', date: DATE, start: '09:15', end: '09:45', student_ids: [s1] },
  });
  assert.equal(bad.status, 400);
  // Özel ders tek öğrenci
  const two = await teacher('/api/teacher/sessions', {
    method: 'POST', body: { kind: 'ozel', subject: 'Fizik', date: DATE, start: '11:00', end: '12:00', student_ids: [s1, s2] },
  });
  assert.equal(two.status, 400);
  // Geçmiş tarih reddedilir
  const past = await teacher('/api/teacher/sessions', {
    method: 'POST', body: { kind: 'ozel', subject: 'Fizik', date: addDays(today(), -1), start: '11:00', end: '12:00', student_ids: [s2] },
  });
  assert.equal(past.status, 400);

  const ok = await teacher('/api/teacher/sessions', {
    method: 'POST', body: { kind: 'ozel', subject: 'Fizik', date: DATE, start: '09:15', end: '09:45', student_ids: [s2] },
  });
  assert.equal(ok.status, 200);
  const etut = await teacher('/api/teacher/sessions', {
    method: 'POST', body: { kind: 'etut', subject: 'Soru çözümü', date: DATE, start: '13:00', end: '14:00', student_ids: [s1, s2] },
  });
  assert.equal(etut.status, 200);
  // Öğretmen artık 09:15'te dolu
  const again = await teacher(`/api/teacher/students?date=${DATE}&start=09:30&end=09:40`);
  assert.match(again.data.teacher_busy, /Özel Ders/);

  // Öğrenci programı: Zeynep'in o günü özel ders + etüt
  const zeynep = await login('zeynep');
  const sched = await zeynep(`/api/schedule?week=${DATE}`);
  const day = sched.data.days.find((d) => d.date === DATE);
  assert.deepEqual(day.items.map((i) => [i.kind, i.start, i.who]), [['ozel', '09:15', 'Mehmet Hoca'], ['etut', '13:00', 'Mehmet Hoca']]);
  // Ali: sınıf dersi + etüt
  const aliS = await (await login('ali'))(`/api/schedule?week=${DATE}`);
  const aliDay = aliS.data.days.find((d) => d.date === DATE);
  assert.deepEqual(aliDay.items.map((i) => i.kind), ['ders', 'etut']);

  // Zeynep'i 12-A'ya almak: 09:15 özel dersi Matematik dersiyle çakışır
  const move = await admin(`/api/admin/users/${s2}`, { method: 'PATCH', body: { class_id: c.data.id } });
  assert.equal(move.status, 400);
  assert.match(move.data.error, /çakışıyor/);
  // Öğrenciler yönetici işlemi yapamaz
  assert.equal((await zeynep('/api/admin/overview')).status, 403);

  // Öğretmen silince programdan kalkar
  await teacher(`/api/teacher/sessions/${ok.data.id}`, { method: 'DELETE' });
  const after = await zeynep(`/api/schedule?week=${DATE}`);
  assert.equal(after.data.days.find((d) => d.date === DATE).items.length, 1);
});

test('öğretmen sınıfa ve öğrenciye dosya yükler; sadece ilgili öğrenci görür', async () => {
  const ayse = await login('ayse');
  const classes = (await ayse('/api/teacher/classes')).data;
  assert.deepEqual(classes.map((c) => c.name), ['12-A']);
  const { students } = (await ayse('/api/teacher/students')).data;
  const zeynepId = students.find((s) => s.name === 'Zeynep').id;
  const otherClass = db.prepare("SELECT id FROM classes WHERE name = '11-B'").get().id;

  const send = (target, target_id, name, title = '') => {
    const fd = new FormData();
    fd.append('target', target); fd.append('target_id', String(target_id)); fd.append('title', title);
    fd.append('file', new Blob(['merhaba']), name);
    return ayse('/api/teacher/files', { method: 'POST', form: fd });
  };
  assert.equal((await send('class', classes[0].id, 'türev-föyü.pdf', 'Türev föyü')).status, 200);
  assert.equal((await send('student', zeynepId, 'özel.pdf')).status, 200);
  assert.equal((await send('class', otherClass, 'x.pdf')).status, 400, 'ders vermediği sınıfa yükleyemez');

  const ali = await login('ali');
  const aliFiles = (await ali('/api/files')).data;
  assert.deepEqual(aliFiles.map((f) => f.title), ['Türev föyü']);
  const dl = await ali(`/api/files/${aliFiles[0].id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'merhaba');

  const zeynep = await login('zeynep');
  const zf = (await zeynep('/api/files')).data;
  assert.deepEqual(zf.map((f) => [f.title, f.original_name]), [['özel.pdf', 'özel.pdf']]);
  // Ali, Zeynep'e özel dosyayı indiremez
  assert.equal((await ali(`/api/files/${zf[0].id}/download`)).status, 404);
});
