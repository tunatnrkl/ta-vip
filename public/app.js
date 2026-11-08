'use strict';

// ================= Yardımcılar =================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const KIND = { ders: 'Ders', ozel: 'Özel Ders', etut: 'Etüt' };

const fmtDate = (d) => { const [, m, day] = d.split('-').map(Number); return `${day} ${MONTHS[m - 1]}`; };
const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2500);
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    state.user = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || 'Bir hata oluştu.');
  return data;
}

/** Bir işlemi çalıştırır, hata olursa kullanıcıya gösterir. */
async function run(fn, button) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; } finally { if (button) button.disabled = false; }
}

// ================= Simgeler =================
const ICONS = {
  calendar: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  file: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  door: '<path d="M4 21h16M6 21V4h12v17M14 12h.01"/>',
  teacher: '<path d="M3 9l9-5 9 5-9 5-9-5z"/><path d="M7 11v5c3 2 7 2 10 0v-5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.5 2.4 3.5 5.5"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

// ================= Durum ve yönlendirme =================
const state = { user: null, tab: null, week: null, sub: null };

const TABS = {
  student: [['program', 'Programım', 'calendar'], ['files', 'Dosyalar', 'file'], ['profile', 'Profil', 'user']],
  teacher: [['program', 'Programım', 'calendar'], ['add', 'Ders Ekle', 'plus'], ['files', 'Dosyalar', 'file'], ['profile', 'Profil', 'user']],
  admin: [['classes', 'Sınıflar', 'door'], ['teachers', 'Öğretmenler', 'teacher'], ['students', 'Öğrenciler', 'users'], ['profile', 'Profil', 'user']],
};

function render() {
  const app = $('#app');
  if (!state.user) { renderLogin(app); return; }
  const tabs = TABS[state.user.role];
  if (!tabs.some((t) => t[0] === state.tab)) state.tab = tabs[0][0];
  app.innerHTML = `
    <header class="top"><h1 id="title"></h1></header>
    <main id="view"></main>
    <nav class="tabs"><div class="tabs-inner">
      ${tabs.map(([k, label, ic]) => `<button data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${icon(ic)}${label}</button>`).join('')}
    </div></nav>`;
  $$('.tabs button', app).forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab; state.sub = null;
    if (b.dataset.tab === 'program') state.week = null;
    render();
  }));
  renderView();
}

function setTitle(text, onBack) {
  const top = $('.top');
  top.innerHTML = `${onBack ? '<button class="back">‹ Geri</button>' : ''}<h1>${esc(text)}</h1>`;
  if (onBack) $('.back', top).addEventListener('click', onBack);
}

async function renderView() {
  const el = $('#view');
  const views = {
    program: viewProgram, add: viewAddSession, files: state.user.role === 'teacher' ? viewTeacherFiles : viewStudentFiles,
    profile: viewProfile, classes: state.sub ? viewClassDetail : viewClasses, teachers: viewTeachers, students: viewStudents,
  };
  el.innerHTML = '<p class="empty">Yükleniyor…</p>';
  try {
    await views[state.tab](el);
  } catch (e) {
    el.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// ================= Giriş =================
function renderLogin(app) {
  app.innerHTML = `
    <form class="login" id="loginForm">
      <img class="logo" src="icon.svg" alt="">
      <h1>TA VIP</h1>
      <p class="muted">Hesabınızla giriş yapın</p>
      <label>Kullanıcı adı <input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label>Şifre <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn block" type="submit">Giriş Yap</button>
    </form>`;
  const f = $('#loginForm');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
      state.user = await api('/api/me');
      state.tab = null;
      render();
    }, $('button', f));
  });
}

// ================= Ders programı (öğrenci + öğretmen) =================
async function viewProgram(el) {
  setTitle(state.user.role === 'student' ? 'Ders Programım' : 'Programım');
  const data = await api(`/api/schedule?week=${state.week || localToday()}`);
  state.week = data.monday;
  const sunday = addDays(data.monday, 6);
  const isThisWeek = data.today >= data.monday && data.today <= sunday;
  const canDelete = state.user.role === 'teacher';

  el.innerHTML = `
    <div class="weeknav">
      <button data-w="-7" aria-label="Önceki hafta">‹</button>
      <div class="label">${fmtDate(data.monday)} – ${fmtDate(sunday)}</div>
      <button data-w="7" aria-label="Sonraki hafta">›</button>
    </div>
    ${isThisWeek ? '' : '<button class="thisweek">Bu haftaya dön</button>'}
    ${data.days.map((d) => `
      <section class="day${d.date === data.today ? ' today' : ''}">
        <h3>${DAYS[d.day - 1]} <span>${fmtDate(d.date)}</span></h3>
        ${d.items.length ? d.items.map((it) => `
          <div class="item k-${it.kind}">
            <div class="time"><b>${it.start}</b>${it.end}</div>
            <div class="body">
              <div class="subj">${esc(it.subject)}</div>
              <div class="meta"><span class="badge k-${it.kind}">${KIND[it.kind]}</span>${esc(it.who)}</div>
            </div>
            ${canDelete && it.kind !== 'ders' ? `<button class="icon-btn" data-del="${it.id}" aria-label="Sil">×</button>` : ''}
          </div>`).join('') : '<div class="none">Ders yok</div>'}
      </section>`).join('')}`;

  $$('[data-w]', el).forEach((b) => b.addEventListener('click', () => {
    state.week = addDays(state.week, Number(b.dataset.w)); renderView();
  }));
  $('.thisweek', el)?.addEventListener('click', () => { state.week = null; renderView(); });
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Bu özel ders/etüt silinsin mi? Öğrencinin programından da kalkar.')) return;
    run(async () => { await api(`/api/teacher/sessions/${b.dataset.del}`, { method: 'DELETE' }); toast('Silindi'); renderView(); }, b);
  }));

  $('.day.today', el)?.scrollIntoView({ block: 'start' });
  if ($('.day.today', el)) window.scrollBy(0, -70);
}

// ================= Öğretmen: Özel ders / Etüt ekle =================
async function viewAddSession(el) {
  setTitle('Özel Ders / Etüt Ekle');
  const now = new Date();
  const h = Math.min(now.getHours() + 1, 22);
  const form = { kind: 'ozel', subject: '', date: localToday(), start: `${pad(h)}:00`, end: `${pad(h + 1)}:00` };
  const selected = new Set();
  let students = [];
  let teacherBusy = null;
  let query = '';

  el.innerHTML = `
    <div class="seg">
      <button data-kind="ozel" class="on">Özel Ders (1 öğrenci)</button>
      <button data-kind="etut">Etüt (grup)</button>
    </div>
    <div class="card">
      <label>Ders / Konu <input id="subject" placeholder="Örn. Matematik – Türev" maxlength="60"></label>
      <label>Tarih <input id="date" type="date" min="${localToday()}" value="${form.date}"></label>
      <div class="row">
        <label>Başlangıç <input id="start" type="time" value="${form.start}"></label>
        <label>Bitiş <input id="end" type="time" value="${form.end}"></label>
      </div>
    </div>
    <h2>Öğrenci seç</h2>
    <p class="muted small" style="margin-top:-4px">Sadece bu saatte boş olan öğrenciler seçilebilir.</p>
    <div id="teacherBusy"></div>
    <input id="q" type="search" placeholder="Öğrenci ara…" style="margin-bottom:10px">
    <div id="list" class="list"></div>
    <div class="sticky-save"><button class="btn block" id="save">Kaydet</button></div>`;

  const listEl = $('#list', el);

  function drawList() {
    $('#teacherBusy', el).innerHTML = teacherBusy ? `<div class="warn">Bu saatte siz dolusunuz: ${esc(teacherBusy)}</div>` : '';
    const q = query.toLocaleLowerCase('tr');
    const shown = students
      .filter((s) => !q || s.name.toLocaleLowerCase('tr').includes(q) || (s.class_name || '').toLocaleLowerCase('tr').includes(q))
      .sort((a, b) => (!!a.busy - !!b.busy) || a.name.localeCompare(b.name, 'tr'));
    const type = form.kind === 'ozel' ? 'radio' : 'checkbox';
    listEl.innerHTML = shown.length ? shown.map((s) => `
      <label class="pick${s.busy ? ' busy' : ''}">
        <input type="${type}" name="st" value="${s.id}" ${selected.has(s.id) ? 'checked' : ''} ${s.busy ? 'disabled' : ''}>
        <div class="grow">
          <div class="title">${esc(s.name)}</div>
          <div class="muted small">${esc(s.class_name || 'Sınıfı yok')}${s.busy ? ` · Dolu: ${esc(s.busy)}` : ''}</div>
        </div>
      </label>`).join('') : '<p class="empty">Öğrenci bulunamadı</p>';
    $$('input[name=st]', listEl).forEach((inp) => inp.addEventListener('change', () => {
      const sid = Number(inp.value);
      if (form.kind === 'ozel') selected.clear();
      if (inp.checked) selected.add(sid); else selected.delete(sid);
    }));
  }

  async function load() {
    form.date = $('#date', el).value; form.start = $('#start', el).value; form.end = $('#end', el).value;
    if (!form.date || !form.start || !form.end || form.start >= form.end) {
      students = []; teacherBusy = null;
      listEl.innerHTML = '<p class="empty">Önce geçerli bir tarih ve saat seçin</p>';
      return;
    }
    const data = await api(`/api/teacher/students?date=${form.date}&start=${form.start}&end=${form.end}`);
    students = data.students; teacherBusy = data.teacher_busy;
    for (const s of students) if (s.busy) selected.delete(s.id);
    drawList();
  }

  $$('.seg button', el).forEach((b) => b.addEventListener('click', () => {
    form.kind = b.dataset.kind;
    $$('.seg button', el).forEach((x) => x.classList.toggle('on', x === b));
    if (form.kind === 'ozel' && selected.size > 1) selected.clear();
    drawList();
  }));
  ['date', 'start', 'end'].forEach((k) => $(`#${k}`, el).addEventListener('change', () => run(load)));
  $('#q', el).addEventListener('input', (e) => { query = e.target.value; drawList(); });

  $('#save', el).addEventListener('click', (e) => run(async () => {
    form.subject = $('#subject', el).value.trim();
    if (!form.subject) throw new Error('Ders / konu yazın.');
    if (selected.size === 0) throw new Error('En az bir öğrenci seçin.');
    await api('/api/teacher/sessions', { method: 'POST', body: { ...form, student_ids: [...selected] } });
    toast(`${KIND[form.kind]} eklendi, öğrencinin programına yansıdı.`);
    state.tab = 'program'; state.week = form.date;
    render();
  }, e.currentTarget));

  await load();
}

// ================= Dosyalar =================
function fileRow(f, { canDelete }) {
  const target = f.class_name ? `${esc(f.class_name)} sınıfı` : (canDelete ? esc(f.student_name) : 'Sana özel');
  return `
    <div class="li">
      <div class="grow">
        <a class="title" href="/api/files/${f.id}/download" style="color:inherit">${esc(f.title)}</a>
        <div class="muted small">${canDelete ? '' : `${esc(f.teacher_name)} · `}${target} · ${fmtSize(f.size)} · ${fmtDate(f.created_at.slice(0, 10))}</div>
      </div>
      ${canDelete
        ? `<button class="icon-btn" data-del="${f.id}" aria-label="Sil">×</button>`
        : `<a class="btn ghost" href="/api/files/${f.id}/download">İndir</a>`}
    </div>`;
}

async function viewStudentFiles(el) {
  setTitle('Ders Dosyaları');
  const files = await api('/api/files');
  el.innerHTML = files.length
    ? `<div class="list">${files.map((f) => fileRow(f, { canDelete: false })).join('')}</div>`
    : '<p class="empty">Henüz dosya yok</p>';
}

async function viewTeacherFiles(el) {
  setTitle('Dosyalar');
  const [classes, { students }, files] = await Promise.all([
    api('/api/teacher/classes'), api('/api/teacher/students'), api('/api/files'),
  ]);
  el.innerHTML = `
    <form class="card" id="up">
      <label>Kime
        <select name="to" required>
          <option value="">Seçin…</option>
          ${classes.length ? `<optgroup label="Sınıflarım">${classes.map((c) => `<option value="class:${c.id}">${esc(c.name)} (tüm sınıf)</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Öğrenciler">${students.map((s) => `<option value="student:${s.id}">${esc(s.name)}${s.class_name ? ` – ${esc(s.class_name)}` : ''}</option>`).join('')}</optgroup>
        </select>
      </label>
      <label>Başlık (isteğe bağlı) <input name="title" maxlength="100" placeholder="Örn. Türev çalışma kağıdı"></label>
      <label>Dosya <input name="file" type="file" required></label>
      <button class="btn block" type="submit">Yükle</button>
    </form>
    <h2>Yüklediklerim</h2>
    ${files.length ? `<div class="list">${files.map((f) => fileRow(f, { canDelete: true })).join('')}</div>` : '<p class="empty">Henüz dosya yüklemediniz</p>'}`;

  const f = $('#up', el);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      const [target, targetId] = f.to.value.split(':');
      const fd = new FormData();
      fd.append('target', target); fd.append('target_id', targetId);
      fd.append('title', f.title.value); fd.append('file', f.file.files[0]);
      await api('/api/teacher/files', { method: 'POST', body: fd });
      toast('Dosya yüklendi');
      renderView();
    }, $('button[type=submit]', f));
  });
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Dosya silinsin mi?')) return;
    run(async () => { await api(`/api/teacher/files/${b.dataset.del}`, { method: 'DELETE' }); toast('Silindi'); renderView(); }, b);
  }));
}

// ================= Profil =================
async function viewProfile(el) {
  setTitle('Profil');
  const me = await api('/api/me');
  const roleName = { admin: 'Yönetici', teacher: 'Öğretmen', student: 'Öğrenci' }[me.role];
  el.innerHTML = `
    <div class="card">
      <div class="title" style="font-size:18px;font-weight:700">${esc(me.name)}</div>
      <div class="muted">${roleName} · @${esc(me.username)}${me.class_name ? ` · ${esc(me.class_name)}` : ''}</div>
    </div>
    <details class="card">
      <summary>Şifremi değiştir</summary>
      <form id="pw">
        <label>Mevcut şifre <input name="current" type="password" autocomplete="current-password" required></label>
        <label>Yeni şifre <input name="next" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn block" type="submit">Kaydet</button>
      </form>
    </details>
    <button class="btn danger block" id="logout">Çıkış Yap</button>`;
  const f = $('#pw', el);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      f.reset(); toast('Şifre değiştirildi');
    }, $('button', f));
  });
  $('#logout', el).addEventListener('click', () => run(async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null; state.tab = null; render();
  }));
}

// ================= Yönetici =================
const classOptions = (classes, selectedId, emptyLabel = 'Sınıf yok') =>
  `<option value="">${emptyLabel}</option>${classes.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;

function resetPassword(id, name) {
  const pw = prompt(`${name} için yeni şifre (en az 6 karakter):`);
  if (pw === null) return;
  run(async () => { await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { password: pw } }); toast('Şifre güncellendi'); });
}

function deleteUser(id, name) {
  if (!confirm(`${name} silinsin mi? Bu işlem geri alınamaz.`)) return;
  run(async () => { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); toast('Silindi'); renderView(); });
}

function bindUserActions(el) {
  $$('[data-pw]', el).forEach((b) => b.addEventListener('click', () => resetPassword(b.dataset.pw, b.dataset.name)));
  $$('[data-deluser]', el).forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.deluser, b.dataset.name)));
}

function userForm(role, classes) {
  return `
    <details class="card">
      <summary>+ Yeni ${role === 'student' ? 'öğrenci' : 'öğretmen'}</summary>
      <form id="newUser">
        <label>Ad soyad <input name="name" required maxlength="80"></label>
        <label>Kullanıcı adı <input name="username" required maxlength="40" autocapitalize="none" placeholder="örn. ali.yilmaz"></label>
        <label>Şifre <input name="password" required minlength="6"></label>
        ${role === 'student' ? `<label>Sınıf <select name="class_id">${classOptions(classes, null, 'Sonra seçilecek')}</select></label>` : ''}
        <button class="btn block" type="submit">Ekle</button>
      </form>
    </details>`;
}

function bindUserForm(el, role) {
  const f = $('#newUser', el);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/admin/users', {
        method: 'POST',
        body: { role, name: f.name.value, username: f.username.value, password: f.password.value, class_id: f.class_id?.value || null },
      });
      toast(`${f.name.value} eklendi`);
      renderView();
    }, $('button', f));
  });
}

async function viewClasses(el) {
  setTitle('Sınıflar');
  const { classes } = await api('/api/admin/overview');
  el.innerHTML = `
    <form class="card row" id="newClass" style="align-items:flex-end">
      <label style="margin:0">Yeni sınıf <input name="name" required maxlength="40" placeholder="Örn. 12-A, LGS-1"></label>
      <button class="btn" type="submit" style="flex:none">Ekle</button>
    </form>
    ${classes.length ? `<div class="list">${classes.map((c) => `
      <div class="li link" data-open="${c.id}">
        <div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="muted small">${c.student_count} öğrenci · ${c.lesson_count} haftalık ders</div></div>
      </div>`).join('')}</div>` : '<p class="empty">Henüz sınıf yok. Yukarıdan ekleyin.</p>'}`;
  const f = $('#newClass', el);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => { await api('/api/admin/classes', { method: 'POST', body: { name: f.name.value } }); toast('Sınıf eklendi'); renderView(); }, $('button', f));
  });
  $$('[data-open]', el).forEach((r) => r.addEventListener('click', () => { state.sub = Number(r.dataset.open); renderView(); }));
}

async function viewClassDetail(el) {
  const back = () => { state.sub = null; renderView(); };
  const [cls, overview] = await Promise.all([api(`/api/admin/classes/${state.sub}`), api('/api/admin/overview')]);
  setTitle(cls.name, back);
  const others = overview.students.filter((s) => s.class_id !== cls.id);
  const byDay = DAYS.map((name, i) => ({ name, items: cls.lessons.filter((l) => l.day === i + 1) })).filter((d) => d.items.length);

  el.innerHTML = `
    <details class="card" ${cls.lessons.length ? '' : 'open'}>
      <summary>+ Ders ekle (öğretmen ata)</summary>
      ${overview.teachers.length ? `
      <form id="newLesson">
        <label>Öğretmen <select name="teacher_id" required><option value="">Seçin…</option>
          ${overview.teachers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        <label>Ders <input name="subject" required maxlength="60" placeholder="Örn. Matematik"></label>
        <label>Gün <select name="day">${DAYS.map((d, i) => `<option value="${i + 1}">${d}</option>`).join('')}</select></label>
        <div class="row">
          <label>Başlangıç <input name="start" type="time" value="09:00" required></label>
          <label>Bitiş <input name="end" type="time" value="09:40" required></label>
        </div>
        <button class="btn block" type="submit">Ekle</button>
      </form>` : '<p class="muted">Önce Öğretmenler sekmesinden öğretmen ekleyin.</p>'}
    </details>

    <h2>Haftalık ders programı</h2>
    <p class="muted small" style="margin-top:-4px">Buraya eklenen dersler, bu sınıftaki öğrencilerin ve öğretmenin programına otomatik yansır.</p>
    ${byDay.length ? byDay.map((d) => `
      <div class="day"><h3>${d.name}</h3>
        ${d.items.map((l) => `
          <div class="item">
            <div class="time"><b>${l.start_time}</b>${l.end_time}</div>
            <div class="body"><div class="subj">${esc(l.subject)}</div><div class="meta">${esc(l.teacher_name)}</div></div>
            <button class="icon-btn" data-dellesson="${l.id}" aria-label="Sil">×</button>
          </div>`).join('')}
      </div>`).join('') : '<p class="empty">Henüz ders eklenmedi</p>'}


    <h2>Öğrenciler (${cls.students.length})</h2>
    ${cls.students.length ? `<div class="list">${cls.students.map((s) => `
      <div class="li"><div class="grow title">${esc(s.name)}</div>
        <button class="icon-btn" data-remove="${s.id}" aria-label="Sınıftan çıkar" title="Sınıftan çıkar">×</button></div>`).join('')}</div>`
      : '<p class="empty">Bu sınıfta öğrenci yok</p>'}
    ${others.length ? `
    <label style="margin-top:12px">Sınıfa öğrenci ekle
      <select id="addStudent"><option value="">Öğrenci seçin…</option>
        ${others.map((s) => `<option value="${s.id}">${esc(s.name)}${s.class_name ? ` (şu an ${esc(s.class_name)})` : ''}</option>`).join('')}
      </select></label>` : ''}

    <button class="btn danger block" id="delClass" style="margin-top:28px">Sınıfı sil</button>`;

  const f = $('#newLesson', el);
  f?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('/api/admin/lessons', {
        method: 'POST',
        body: { class_id: cls.id, teacher_id: f.teacher_id.value, subject: f.subject.value, day: Number(f.day.value), start: f.start.value, end: f.end.value },
      });
      toast('Ders eklendi'); renderView();
    }, $('button', f));
  });
  $$('[data-dellesson]', el).forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Bu ders programdan silinsin mi?')) return;
    run(async () => { await api(`/api/admin/lessons/${b.dataset.dellesson}`, { method: 'DELETE' }); renderView(); }, b);
  }));
  const setClass = (sid, classId) => run(async () => {
    await api(`/api/admin/users/${sid}`, { method: 'PATCH', body: { class_id: classId } }); renderView();
  });
  $$('[data-remove]', el).forEach((b) => b.addEventListener('click', () => setClass(b.dataset.remove, null)));
  $('#addStudent', el)?.addEventListener('change', (e) => e.target.value && setClass(e.target.value, cls.id));
  $('#delClass', el).addEventListener('click', () => {
    if (!confirm(`${cls.name} sınıfı silinsin mi? Sınıfın ders programı ve dosyaları da silinir; öğrenciler sınıfsız kalır.`)) return;
    run(async () => { await api(`/api/admin/classes/${cls.id}`, { method: 'DELETE' }); toast('Sınıf silindi'); back(); });
  });
}

async function viewTeachers(el) {
  setTitle('Öğretmenler');
  const { teachers } = await api('/api/admin/overview');
  el.innerHTML = `
    ${userForm('teacher')}
    <p class="muted small">Öğretmenin hangi sınıfa ders vereceğini <b>Sınıflar → sınıf → Ders ekle</b> bölümünden belirleyin.</p>
    ${teachers.length ? `<div class="list">${teachers.map((t) => `
      <div class="li">
        <div class="grow"><div class="title">${esc(t.name)}</div>
          <div class="muted small">@${esc(t.username)} · ${esc(t.classes || 'Henüz sınıf atanmadı')}</div></div>
        <button class="icon-btn" data-pw="${t.id}" data-name="${esc(t.name)}" aria-label="Şifre sıfırla" title="Şifre sıfırla">🔑</button>
        <button class="icon-btn" data-deluser="${t.id}" data-name="${esc(t.name)}" aria-label="Sil" title="Sil">×</button>
      </div>`).join('')}</div>` : '<p class="empty">Henüz öğretmen yok</p>'}`;
  bindUserForm(el, 'teacher');
  bindUserActions(el);
}

async function viewStudents(el) {
  setTitle('Öğrenciler');
  const { students, classes } = await api('/api/admin/overview');
  el.innerHTML = `
    ${userForm('student', classes)}
    ${students.length > 6 ? '<input id="q" type="search" placeholder="Öğrenci ara…" style="margin-bottom:10px">' : ''}
    ${students.length ? `<div class="list" id="slist">${students.map((s) => `
      <div class="li" data-name="${esc(s.name.toLocaleLowerCase('tr'))}">
        <div class="grow"><div class="title">${esc(s.name)}</div><div class="muted small">@${esc(s.username)}</div></div>
        <select data-class="${s.id}" aria-label="Sınıf">${classOptions(classes, s.class_id)}</select>
        <button class="icon-btn" data-pw="${s.id}" data-name="${esc(s.name)}" aria-label="Şifre sıfırla" title="Şifre sıfırla">🔑</button>
        <button class="icon-btn" data-deluser="${s.id}" data-name="${esc(s.name)}" aria-label="Sil" title="Sil">×</button>
      </div>`).join('')}</div>` : '<p class="empty">Henüz öğrenci yok</p>'}`;
  bindUserForm(el, 'student');
  bindUserActions(el);
  $$('[data-class]', el).forEach((sel) => {
    let before = sel.value;
    sel.addEventListener('change', () => run(async () => {
      try {
        await api(`/api/admin/users/${sel.dataset.class}`, { method: 'PATCH', body: { class_id: sel.value || null } });
        before = sel.value;
        toast('Sınıf güncellendi');
      } catch (e) { sel.value = before; throw e; }
    }));
  });
  $('#q', el)?.addEventListener('input', (e) => {
    const q = e.target.value.toLocaleLowerCase('tr');
    $$('#slist .li', el).forEach((r) => { r.hidden = !r.dataset.name.includes(q); });
  });
}

// ================= Başlat =================
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { state.user = await api('/api/me'); } catch { state.user = null; }
  render();
})();
