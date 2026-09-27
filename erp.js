// Safa Shipping Console — ERP module (phase 1: shipments & operations)
// Mounted by server.js. Stores data in data/erp.db (JSON) with daily backups in data/backups/.
const fs = require('fs');
const path = require('path');

// ---------------- roles & permissions ----------------
const ROLES = {
  admin:      { label: 'مدير النظام',   perms: ['*'] },
  operations: { label: 'العمليات',      perms: ['jobs.write', 'parties.write', 'fleet.write', 'tasks.write'] },
  sales:      { label: 'المبيعات',      perms: ['jobs.create', 'parties.write', 'tasks.write'] },
  customs:    { label: 'التخليص الجمركي', perms: ['jobs.customs', 'tasks.write'] },
  accounts:   { label: 'المحاسبة',      perms: ['tasks.write'] },
  viewer:     { label: 'مشاهدة فقط',    perms: [] },
};
const can = (u, p) => { const r = ROLES[u.role] || ROLES.viewer; return r.perms.includes('*') || r.perms.includes(p); };

// ---------------- enums ----------------
const MODES = ['SE', 'SI', 'LE', 'LI', 'LT', 'CC']; // sea export/import, land export/import/transit, customs clearance
const family = (m) => (m === 'SE' || m === 'SI') ? 'sea' : (m === 'CC' ? 'customs' : 'land');
const STATUSES = {
  sea:     ['draft', 'booked', 'loaded', 'sailed', 'arrived', 'clearing', 'released', 'delivered', 'closed', 'cancelled'],
  land:    ['draft', 'booked', 'loaded', 'in_transit', 'at_border', 'clearing', 'delivered', 'closed', 'cancelled'],
  customs: ['draft', 'awaiting_docs', 'declared', 'inspection', 'duty_paid', 'released', 'closed', 'cancelled'],
};
const CLOSED = ['delivered', 'closed', 'cancelled', 'released'];
const INCOTERMS = ['', 'EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];
const PARTY_TYPES = ['customer', 'agent', 'carrier', 'trucking', 'broker', 'supplier'];

// ---------------- schema-based sanitising ----------------
const S = {
  str: (v) => String(v ?? '').trim().slice(0, 200),
  text: (v) => String(v ?? '').trim().slice(0, 3000),
  num: (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; },
  int: (v) => { const n = S.num(v); return n == null ? null : Math.round(n); },
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '',
  bool: (v) => v === true || v === 'true' || v === 1 || v === '1',
  enumOf: (list) => (v) => list.includes(v) ? v : list[0],
};
function clean(schema, input, partial = false) {
  const out = {};
  for (const [k, fn] of Object.entries(schema)) {
    if (partial && !(k in input)) continue;
    out[k] = fn(input[k]);
  }
  return out;
}
const CONTAINER = { no: (v) => S.str(v).toUpperCase().replace(/\s+/g, ''), type: S.str, seal: S.str, kg: S.num };

const SCHEMAS = {
  parties: {
    name: S.str, type: S.enumOf(PARTY_TYPES), contact: S.str, phone: S.str, email: S.str,
    country: S.str, city: S.str, address: S.text, taxNo: S.str, notes: S.text, active: (v) => v === undefined ? true : S.bool(v),
  },
  trucks: {
    plate: S.str, type: S.str, capacityKg: S.num, trailer: S.str,
    status: S.enumOf(['available', 'on_trip', 'maintenance', 'inactive']),
    licenseExpiry: S.date, insuranceExpiry: S.date, inspectionExpiry: S.date, notes: S.text,
  },
  drivers: {
    name: S.str, phone: S.str, licenseNo: S.str, licenseExpiry: S.date, passportExpiry: S.date,
    status: S.enumOf(['available', 'on_trip', 'off']), notes: S.text,
  },
  tasks: { jobId: S.int, title: S.str, due: S.date, assignee: S.int, done: S.bool, note: S.text },
};
const JOB_FIELDS = {
  customerId: S.int, shipper: S.str, consignee: S.str, incoterm: S.enumOf(INCOTERMS),
  origin: S.str, destination: S.str, carrierId: S.int, agentId: S.int, brokerId: S.int,
  vessel: S.str, voyage: S.str, bookingNo: S.str, mbl: S.str, hbl: S.str,
  cmr: S.str, truckId: S.int, driverId: S.int, trailer: S.str, border: S.str,
  etd: S.date, eta: S.date, atd: S.date, ata: S.date, freeDays: S.int,
  cargo: S.text, packages: S.int, pkgType: S.str, grossKg: S.num, cbm: S.num, hsCode: S.str,
  containers: (v) => Array.isArray(v) ? v.slice(0, 60).map((c) => clean(CONTAINER, c || {})).filter((c) => c.no || c.type) : [],
  declNo: S.str, declDate: S.date, customsOffice: S.str, channel: S.enumOf(['', 'green', 'yellow', 'red']), dutyAmount: S.num,
  assignedTo: S.int, priority: S.enumOf(['normal', 'high', 'urgent']), notes: S.text,
};
const CUSTOMS_FIELDS = ['declNo', 'declDate', 'customsOffice', 'channel', 'dutyAmount', 'hsCode', 'brokerId'];

module.exports = function mountErp(app, ctx) {
  const FILE = path.join(ctx.dataDir, 'erp.db');
  const BK = path.join(ctx.dataDir, 'backups');
  fs.mkdirSync(BK, { recursive: true });
  let E = { seq: {}, parties: [], jobs: [], tasks: [], events: [], trucks: [], drivers: [] };
  try { E = Object.assign(E, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) {}

  function save() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(E));
    fs.renameSync(tmp, FILE);
    // one backup per day, keep the last 14
    const day = new Date().toISOString().slice(0, 10);
    const bk = path.join(BK, `erp-${day}.bak`);
    if (!fs.existsSync(bk)) {
      fs.copyFileSync(FILE, bk);
      fs.readdirSync(BK).filter((f) => f.endsWith('.bak')).sort().slice(0, -14).forEach((f) => fs.unlinkSync(path.join(BK, f)));
    }
  }
  const nextId = (col) => (E.seq[col] = (E.seq[col] || 0) + 1);
  const now = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------------- users & roles ----------------
  function roleOf(u) {
    if (u.role && ROLES[u.role]) return u.role;
    const users = ctx.users();
    if (!users.some((x) => x.role === 'admin' && x.status === 'active')) {
      // No admin yet: the admin email's account, otherwise the oldest active account, becomes admin.
      const active = users.filter((x) => x.status === 'active').sort((a, b) => a.id - b.id);
      const first = active.find((x) => String(x.email).toLowerCase() === String(ctx.adminEmail).toLowerCase()) || active[0];
      if (first) first.role = 'admin';
    }
    if (!u.role) u.role = String(u.email).toLowerCase() === String(ctx.adminEmail).toLowerCase() ? 'admin' : 'viewer';
    ctx.saveUsers();
    return u.role;
  }
  const userName = (id) => { const u = ctx.users().find((x) => x.id === id); return u ? u.username : ''; };

  // auth middleware
  app.use('/api/erp', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const u = ctx.currentUser(req);
    if (!u) return res.status(401).json({ ok: false, error: 'انتهت الجلسة. سجّل الدخول من جديد.' });
    roleOf(u);
    req.user = u;
    next();
  });
  const deny = (res, msg = 'ليست لديك صلاحية لهذا الإجراء.') => res.status(403).json({ ok: false, error: msg });
  const bad = (res, msg) => res.status(422).json({ ok: false, error: msg });
  const notFound = (res) => res.status(404).json({ ok: false, error: 'العنصر غير موجود.' });
  const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { console.error('ERP error:', e); res.status(500).json({ ok: false, error: 'حدث خطأ في الخادم.' }); } };

  function logEvent(jobId, user, type, text) {
    E.events.push({ id: nextId('events'), jobId, at: now(), by: user.username, type, text: String(text).slice(0, 1000) });
  }

  // ---------------- meta ----------------
  app.get('/api/erp/meta', wrap((req, res) => {
    const u = req.user;
    res.json({
      ok: true,
      user: { id: u.id, username: u.username, email: u.email, role: u.role, roleLabel: ROLES[u.role].label, perms: ROLES[u.role].perms },
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
      users: ctx.users().filter((x) => x.status === 'active').map((x) => ({ id: x.id, username: x.username, role: x.role || 'viewer' })),
    });
  }));

  // ---------------- dashboard ----------------
  app.get('/api/erp/dashboard', wrap((req, res) => {
    const t = today();
    const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const open = E.jobs.filter((j) => !CLOSED.includes(j.status));
    const byMode = Object.fromEntries(MODES.map((m) => [m, open.filter((j) => j.mode === m).length]));
    const arriving = open.filter((j) => j.eta && !j.ata && j.eta >= t && j.eta <= in7).sort((a, b) => a.eta.localeCompare(b.eta));
    const overdue = open.filter((j) => j.eta && !j.ata && j.eta < t);
    const tasksOpen = E.tasks.filter((x) => !x.done);
    const tasksLate = tasksOpen.filter((x) => x.due && x.due < t);
    const expiring = [
      ...E.trucks.flatMap((x) => [['licenseExpiry', 'رخصة المركبة'], ['insuranceExpiry', 'التأمين'], ['inspectionExpiry', 'الفحص الفني']]
        .filter(([k]) => x[k] && x[k] <= in30).map(([k, l]) => ({ kind: 'truck', id: x.id, name: x.plate, what: l, date: x[k] }))),
      ...E.drivers.flatMap((x) => [['licenseExpiry', 'رخصة القيادة'], ['passportExpiry', 'جواز السفر']]
        .filter(([k]) => x[k] && x[k] <= in30).map(([k, l]) => ({ kind: 'driver', id: x.id, name: x.name, what: l, date: x[k] }))),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const slim = (j) => ({ id: j.id, no: j.no, mode: j.mode, status: j.status, eta: j.eta, customer: partyName(j.customerId), origin: j.origin, destination: j.destination });
    res.json({
      ok: true,
      counts: { open: open.length, arriving: arriving.length, overdue: overdue.length, tasksOpen: tasksOpen.length, tasksLate: tasksLate.length, expiring: expiring.length, parties: E.parties.length, trucks: E.trucks.length },
      byMode,
      arriving: arriving.slice(0, 8).map(slim),
      overdue: overdue.slice(0, 8).map(slim),
      myTasks: tasksOpen.filter((x) => x.assignee === req.user.id).sort((a, b) => (a.due || '9').localeCompare(b.due || '9')).slice(0, 8).map((x) => ({ ...x, jobNo: jobNo(x.jobId) })),
      expiring: expiring.slice(0, 8),
      recent: E.events.slice(-10).reverse().map((e) => ({ ...e, jobNo: jobNo(e.jobId) })),
    });
  }));
  const partyName = (id) => { const p = E.parties.find((x) => x.id === id); return p ? p.name : ''; };
  const jobNo = (id) => { const j = E.jobs.find((x) => x.id === id); return j ? j.no : ''; };

  // ---------------- jobs ----------------
  app.get('/api/erp/jobs', wrap((req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    let list = E.jobs.slice().reverse();
    if (req.query.mode) list = list.filter((j) => j.mode === req.query.mode);
    if (req.query.status) list = list.filter((j) => j.status === req.query.status);
    if (req.query.open === '1') list = list.filter((j) => !CLOSED.includes(j.status));
    if (req.query.customerId) list = list.filter((j) => j.customerId === +req.query.customerId);
    if (q) list = list.filter((j) => [j.no, partyName(j.customerId), j.shipper, j.consignee, j.origin, j.destination, j.mbl, j.hbl, j.cmr, j.bookingNo, j.declNo, j.vessel,
      ...(j.containers || []).map((c) => c.no)].join(' ').toLowerCase().includes(q));
    res.json({ ok: true, jobs: list.slice(0, 500).map((j) => ({ ...j, customer: partyName(j.customerId), assignee: userName(j.assignedTo) })) });
  }));

  app.get('/api/erp/jobs/:id', wrap((req, res) => {
    const j = E.jobs.find((x) => x.id === +req.params.id);
    if (!j) return notFound(res);
    res.json({
      ok: true,
      job: { ...j, customer: partyName(j.customerId), assignee: userName(j.assignedTo) },
      events: E.events.filter((e) => e.jobId === j.id).reverse(),
      tasks: E.tasks.filter((t) => t.jobId === j.id).map((t) => ({ ...t, assigneeName: userName(t.assignee) })),
    });
  }));

  app.post('/api/erp/jobs', wrap((req, res) => {
    if (!can(req.user, 'jobs.write') && !can(req.user, 'jobs.create')) return deny(res);
    const mode = MODES.includes(req.body.mode) ? req.body.mode : null;
    if (!mode) return bad(res, 'اختر نوع الملف.');
    const data = clean(JOB_FIELDS, req.body || {});
    if (!data.customerId || !E.parties.some((p) => p.id === data.customerId)) return bad(res, 'اختر العميل.');
    const yy = String(new Date().getFullYear()).slice(2);
    const key = `${mode}-${yy}`;
    const n = (E.seq[key] = (E.seq[key] || 0) + 1);
    const job = { id: nextId('jobs'), no: `${key}-${String(n).padStart(4, '0')}`, mode, status: 'draft', ...data,
      createdBy: req.user.id, createdAt: now(), updatedAt: now() };
    E.jobs.push(job);
    logEvent(job.id, req.user, 'create', 'تم إنشاء الملف');
    save();
    res.json({ ok: true, job });
  }));

  app.put('/api/erp/jobs/:id', wrap((req, res) => {
    const j = E.jobs.find((x) => x.id === +req.params.id);
    if (!j) return notFound(res);
    const full = can(req.user, 'jobs.write') || (can(req.user, 'jobs.create') && j.createdBy === req.user.id);
    const customsOnly = !full && can(req.user, 'jobs.customs');
    if (!full && !customsOnly) return deny(res);
    let data = clean(JOB_FIELDS, req.body || {}, true);
    if (customsOnly) data = Object.fromEntries(Object.entries(data).filter(([k]) => CUSTOMS_FIELDS.includes(k)));
    if ('customerId' in data && !E.parties.some((p) => p.id === data.customerId)) return bad(res, 'اختر العميل.');
    const changed = Object.keys(data).filter((k) => JSON.stringify(j[k] ?? null) !== JSON.stringify(data[k] ?? null));
    Object.assign(j, data, { updatedAt: now() });
    if (changed.length) logEvent(j.id, req.user, 'update', `تم تعديل ${changed.length} حقل`);
    save();
    res.json({ ok: true, job: j });
  }));

  app.post('/api/erp/jobs/:id/status', wrap((req, res) => {
    const j = E.jobs.find((x) => x.id === +req.params.id);
    if (!j) return notFound(res);
    const allowed = can(req.user, 'jobs.write') || (can(req.user, 'jobs.customs') && family(j.mode) === 'customs') || (can(req.user, 'jobs.create') && j.createdBy === req.user.id);
    if (!allowed) return deny(res);
    const st = String(req.body.status || '');
    if (!STATUSES[family(j.mode)].includes(st)) return bad(res, 'حالة غير صالحة لهذا النوع من الملفات.');
    if (st === j.status) return res.json({ ok: true, job: j });
    const from = j.status;
    j.status = st; j.updatedAt = now();
    const t = today();
    if (st === 'sailed' || st === 'in_transit') j.atd = j.atd || t;
    if (st === 'arrived' || st === 'at_border' || (st === 'delivered' && !j.ata)) j.ata = j.ata || t;
    logEvent(j.id, req.user, 'status', `${from} → ${st}${req.body.note ? ' — ' + S.str(req.body.note) : ''}`);
    save();
    res.json({ ok: true, job: j });
  }));

  app.post('/api/erp/jobs/:id/comment', wrap((req, res) => {
    const j = E.jobs.find((x) => x.id === +req.params.id);
    if (!j) return notFound(res);
    const text = S.text(req.body.text);
    if (!text) return bad(res, 'اكتب التعليق.');
    logEvent(j.id, req.user, 'comment', text);
    save();
    res.json({ ok: true });
  }));

  app.delete('/api/erp/jobs/:id', wrap((req, res) => {
    if (req.user.role !== 'admin') return deny(res, 'الحذف متاح لمدير النظام فقط.');
    const id = +req.params.id;
    if (!E.jobs.some((x) => x.id === id)) return notFound(res);
    E.jobs = E.jobs.filter((x) => x.id !== id);
    E.tasks = E.tasks.filter((x) => x.jobId !== id);
    E.events = E.events.filter((x) => x.jobId !== id);
    save();
    res.json({ ok: true });
  }));

  // ---------------- generic collections ----------------
  const COLS = { parties: 'parties.write', trucks: 'fleet.write', drivers: 'fleet.write', tasks: 'tasks.write' };
  const REQUIRED = { parties: ['name', 'اسم الجهة'], trucks: ['plate', 'رقم اللوحة'], drivers: ['name', 'اسم السائق'], tasks: ['title', 'عنوان المهمة'] };
  for (const [col, perm] of Object.entries(COLS)) {
    app.get(`/api/erp/${col}`, wrap((req, res) => {
      let list = E[col];
      if (col === 'parties') list = list.map((p) => ({ ...p, jobs: E.jobs.filter((j) => [j.customerId, j.carrierId, j.agentId, j.brokerId].includes(p.id)).length }));
      if (col === 'tasks') list = list.map((t) => ({ ...t, jobNo: jobNo(t.jobId), assigneeName: userName(t.assignee) }));
      res.json({ ok: true, items: list });
    }));
    app.post(`/api/erp/${col}`, wrap((req, res) => {
      if (!can(req.user, perm)) return deny(res);
      const data = clean(SCHEMAS[col], req.body || {});
      const [rk, rl] = REQUIRED[col];
      if (!data[rk]) return bad(res, `${rl} مطلوب.`);
      if (col === 'tasks' && data.jobId && !E.jobs.some((j) => j.id === data.jobId)) return bad(res, 'الملف غير موجود.');
      if (col === 'trucks' && E.trucks.some((t) => t.plate.toLowerCase() === data.plate.toLowerCase())) return bad(res, 'رقم اللوحة مسجّل مسبقاً.');
      const item = { id: nextId(col), ...data, createdBy: req.user.id, createdAt: now() };
      E[col].push(item);
      if (col === 'tasks' && item.jobId) logEvent(item.jobId, req.user, 'update', `مهمة جديدة: ${item.title}`);
      save();
      res.json({ ok: true, item });
    }));
    app.put(`/api/erp/${col}/:id`, wrap((req, res) => {
      if (!can(req.user, perm)) return deny(res);
      const it = E[col].find((x) => x.id === +req.params.id);
      if (!it) return notFound(res);
      const data = clean(SCHEMAS[col], req.body || {}, true);
      const [rk, rl] = REQUIRED[col];
      if (rk in data && !data[rk]) return bad(res, `${rl} مطلوب.`);
      Object.assign(it, data, { updatedAt: now() });
      if (col === 'tasks' && 'done' in data && it.jobId) logEvent(it.jobId, req.user, 'update', `${data.done ? 'تم إنجاز' : 'أعيد فتح'} مهمة: ${it.title}`);
      save();
      res.json({ ok: true, item: it });
    }));
    app.delete(`/api/erp/${col}/:id`, wrap((req, res) => {
      if (!can(req.user, perm)) return deny(res);
      const id = +req.params.id;
      if (!E[col].some((x) => x.id === id)) return notFound(res);
      if (col === 'parties' && E.jobs.some((j) => [j.customerId, j.carrierId, j.agentId, j.brokerId].includes(id)))
        return bad(res, 'لا يمكن حذف جهة مرتبطة بملفات شحن. يمكنك تعطيلها بدلاً من ذلك.');
      if (col === 'trucks' && E.jobs.some((j) => j.truckId === id && !CLOSED.includes(j.status))) return bad(res, 'الشاحنة مرتبطة بملف مفتوح.');
      if (col === 'drivers' && E.jobs.some((j) => j.driverId === id && !CLOSED.includes(j.status))) return bad(res, 'السائق مرتبط بملف مفتوح.');
      E[col] = E[col].filter((x) => x.id !== id);
      save();
      res.json({ ok: true });
    }));
  }

  // ---------------- users (admin) ----------------
  app.get('/api/erp/users', wrap((req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    res.json({ ok: true, items: ctx.users().map((u) => ({ id: u.id, username: u.username, email: u.email, role: u.role || 'viewer', status: u.status, created: u.created, lastLogin: u.lastLogin || null })) });
  }));
  app.put('/api/erp/users/:id', wrap((req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    const u = ctx.users().find((x) => x.id === +req.params.id);
    if (!u) return notFound(res);
    const role = req.body.role, status = req.body.status;
    const admins = ctx.users().filter((x) => x.role === 'admin' && x.status === 'active');
    const losingAdmin = u.role === 'admin' && ((role && role !== 'admin') || status === 'disabled');
    if (losingAdmin && admins.length <= 1) return bad(res, 'لا يمكن إزالة آخر مدير للنظام.');
    if (role) { if (!ROLES[role]) return bad(res, 'دور غير صالح.'); u.role = role; }
    if (status === 'disabled' || status === 'active') {
      if (u.status === 'pending' && status === 'active') return bad(res, 'هذا الحساب لم يُفعّل برمز التفعيل بعد.');
      if (u.status !== 'pending') u.status = status;
    }
    ctx.saveUsers();
    res.json({ ok: true });
  }));

  // ---------------- backup (admin) ----------------
  app.get('/api/erp/backup', wrap((req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    res.setHeader('Content-Disposition', `attachment; filename="safa-erp-backup-${today()}.json"`);
    res.json({ exportedAt: now(), erp: E });
  }));
};
