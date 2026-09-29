// Safa Shipping Console — ERP backend v2 (schema-driven)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('./schema');

const ENT = SC.E;
const MODULE_KEYS = SC.MODULES.map((m) => m[0]);
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

// ---------- sanitising by schema type ----------
const T = {
  str: (v) => String(v ?? '').trim().slice(0, 300),
  text: (v) => String(v ?? '').trim().slice(0, 5000),
  num: (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null; },
  int: (v) => { const n = T.num(v); return n == null ? null : Math.round(n); },
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '',
  dt: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 16) : '',
  bool: (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on',
  ref: (v) => T.int(v),
  user: (v) => T.int(v),
  items: (v) => Array.isArray(v) ? v.slice(0, 200).map((it) => ({
    desc: T.str(it.desc), date: T.date(it.date), from: T.str(it.from), to: T.str(it.to), unit: T.str(it.unit),
    qty: T.num(it.qty) ?? 0, price: T.num(it.price) ?? 0, note: T.str(it.note),
  })).filter((it) => it.desc || it.price || it.qty) : [],
  containers: (v) => Array.isArray(v) ? v.slice(0, 80).map((c) => ({
    no: T.str(c.no).toUpperCase().replace(/\s+/g, ''), type: T.str(c.type), seal: T.str(c.seal), kg: T.num(c.kg),
  })).filter((c) => c.no || c.type) : [],
};
function clean(ent, input, partial) {
  const out = {};
  for (const [k, f] of Object.entries(ENT[ent].fields)) {
    if (f.auto || f.calc) continue;
    if (partial && !(k in input)) continue;
    let v = input[k];
    if (f.t === 'enum') { const vals = f.opts.map((o) => o[0]); v = vals.includes(v) ? v : (partial && v === undefined ? undefined : vals[0]); }
    else v = (T[f.t] || T.str)(v);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
const lineTotal = (items) => (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = async function mountErp(app, ctx) {
  const FILE = path.join(ctx.dataDir, 'erp.db');
  const FILES = path.join(ctx.dataDir, 'files');
  fs.mkdirSync(FILES, { recursive: true });

  // state lives in the store (PostgreSQL in production); E is the in-memory working copy
  const ST = await ctx.store.open('erp', { file: FILE, defaults: { seq: {}, events: [], audit: [], prefs: {}, settings: {} } });
  const E = ST.state;
  for (const k of ['events', 'audit']) if (!Array.isArray(E[k])) E[k] = [];
  for (const k of ['seq', 'prefs', 'settings']) if (!E[k] || typeof E[k] !== 'object' || Array.isArray(E[k])) E[k] = {};
  for (const k of Object.keys(ENT)) if (!Array.isArray(E[k])) E[k] = [];

  // ---- migrations from v1 ----
  E.parties.forEach((p) => {
    if (!p.status) p.status = p.active === false ? 'inactive' : 'active';
    if (!p.code) p.code = 'CUST-' + String(p.id).padStart(6, '0');
  });
  E.jobs.forEach((j) => { if (!j.priority) j.priority = 'normal'; });
  // phase-1 status events stored "from → to — note" without structured fields
  E.events.forEach((e) => {
    if (e.type === 'status' && !e.to) {
      const m = String(e.text).match(/^(\w+) → (\w+)(?: — (.*))?$/);
      if (m && SC.JOB_STATUS[m[2]]) { e.from = m[1]; e.to = m[2]; e.note = m[3] || ''; e.text = `${(SC.JOB_STATUS[m[1]] || [m[1]])[0]} ← ${SC.JOB_STATUS[m[2]][0]}`; }
    }
  });
  // v1 status events stored "from → to — note" with raw keys; convert to structured Arabic events
  E.events.forEach((e) => {
    if (e.type !== 'status' || e.to) return;
    const m = String(e.text || '').match(/^(\w+)\s*→\s*(\w+)(?:\s*—\s*(.*))?$/);
    if (!m || !SC.JOB_STATUS[m[1]] || !SC.JOB_STATUS[m[2]]) return;
    e.from = m[1]; e.to = m[2]; e.note = m[3] || '';
    e.text = `${SC.JOB_STATUS[m[1]][0]} ← ${SC.JOB_STATUS[m[2]][0]}`;
  });

  // ---- settings defaults ----
  const DEF_SETTINGS = {
    company: { name: 'Safa Shipping Console', nameAr: 'صفا للشحن والخدمات اللوجستية', address: '', phone: '', email: '', taxNo: '', website: '' },
    base: 'USD',
    currencies: [['USD', 1], ['EUR', 0.92], ['SAR', 3.75], ['AED', 3.6725], ['SYP', 13000], ['JOD', 0.709], ['TRY', 34]],
    invoice: { taxRate: 0, dueDays: 30, terms: 'يرجى السداد خلال 30 يوماً من تاريخ الفاتورة.', bankName: '', iban: '', account: '' },
    quality: { audit: { progress: 60, date: '', next: '', steps: [['التخطيط', true], ['التنفيذ', true], ['المراجعة', false], ['الإغلاق', false]] }, satisfaction: 90 },
    notify: { contracts: true, ops: true, customers: true, finance: true, system: true },
    security: { require2fa: [] },
    roles: null,
  };
  E.settings = Object.assign({}, DEF_SETTINGS, E.settings || {});
  if (!E.settings.roles) E.settings.roles = buildRoles();
  if (!E.settings.security || !Array.isArray(E.settings.security.require2fa)) E.settings.security = { require2fa: [] };
  function buildRoles() {
    const out = {};
    for (const [r, d] of Object.entries(SC.ROLE_DEFAULTS)) {
      out[r] = { label: d.label, perms: {} };
      for (const m of MODULE_KEYS) out[r].perms[m] = d.portal ? '' : (d[m] ?? d.all ?? '');
    }
    return out;
  }

  // Transactional save: on failure memory is reloaded from the database so nothing stays half-applied.
  async function save() {
    try { await ST.save(); }
    catch (e) { console.error('[db] erp save failed (changes rolled back):', e.message); throw new Error('DBSAVE'); }
  }
  global.__erpFlush = save;
  const nextId = (col) => (E.seq[col] = (E.seq[col] || 0) + 1);
  const yy = () => String(new Date().getFullYear()).slice(2);
  // audit entries before v3 used `id` for the changed record: move it to `rid` and give each entry its own id
  E.audit.forEach((a) => { if (!('rid' in a)) { a.rid = a.id ?? null; a.id = nextId('audit'); } });
  await save();

  // ---------- users & permissions ----------
  function roleOf(u) {
    if (u.role && E.settings.roles[u.role]) return u.role;
    const users = ctx.users();
    if (!users.some((x) => x.role === 'admin' && x.status === 'active')) {
      const active = users.filter((x) => x.status === 'active').sort((a, b) => a.id - b.id);
      const first = active.find((x) => String(x.email).toLowerCase() === String(ctx.adminEmail).toLowerCase()) || active[0];
      if (first) first.role = 'admin';
    }
    if (!u.role || !E.settings.roles[u.role]) u.role = String(u.email).toLowerCase() === String(ctx.adminEmail).toLowerCase() ? 'admin' : 'viewer';
    ctx.saveUsers().catch(() => {});
    return u.role;
  }
  const permsOf = (u) => u.role === 'admin' ? Object.fromEntries(MODULE_KEYS.map((m) => [m, 'rcud'])) : ((E.settings.roles[u.role] || {}).perms || {});
  const can = (u, mod, act) => u.role === 'admin' || String(permsOf(u)[mod] || '').includes(act);
  const isClient = (u) => u.role === 'client';
  const userName = (id) => { const u = ctx.users().find((x) => x.id === id); return u ? u.username : ''; };

  app.use('/api/erp', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const u = ctx.currentUser(req);
    if (!u) return res.status(401).json({ ok: false, error: 'انتهت الجلسة. سجّل الدخول من جديد.' });
    roleOf(u);
    req.user = u;
    next();
  });
  const deny = (res, m = 'ليست لديك صلاحية لهذا الإجراء.') => res.status(403).json({ ok: false, error: m });
  const bad = (res, m) => res.status(422).json({ ok: false, error: m });
  const nf = (res) => res.status(404).json({ ok: false, error: 'العنصر غير موجود.' });
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (res.headersSent) return;
      if (e.message === 'DBSAVE') return res.status(503).json({ ok: false, error: 'تعذّر حفظ البيانات حالياً ولم يتم تطبيق التغيير. حاول مرة أخرى بعد لحظات.' });
      console.error('ERP error:', e); res.status(500).json({ ok: false, error: 'حدث خطأ في الخادم.' });
    }
  };
  function audit(u, entity, id, action, label) {
    E.audit.push({ id: nextId('audit'), at: now(), by: u.username, entity, rid: id, action, label: String(label || '').slice(0, 200) });
    if (E.audit.length > 5000) E.audit.splice(0, E.audit.length - 5000);
  }
  function jobEvent(jobId, u, type, text, extra = {}) {
    E.events.push({ id: nextId('events'), jobId, at: now(), by: u.username, type, text: String(text).slice(0, 2000), ...extra });
  }

  // ---------- computed fields ----------
  function invoiceView(inv) {
    const paid = r2(E.payments.filter((p) => p.invoiceId === inv.id).reduce((s, p) => s + (p.amount || 0), 0));
    let status = inv.state;
    if (inv.state === 'issued') {
      if (paid >= inv.total - 0.005 && inv.total > 0) status = 'paid';
      else if (paid > 0) status = 'partial';
      else if (inv.dueDate && inv.dueDate < today()) status = 'overdue';
    }
    return { ...inv, paid, balance: r2((inv.total || 0) - paid), status };
  }
  function contractView(c) {
    let status = c.state;
    if (c.state === 'active' && c.end) {
      const days = Math.round((new Date(c.end) - new Date(today())) / 864e5);
      status = days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'active';
    }
    return { ...c, status };
  }
  function inventoryView(i) {
    const end = i.dateOut || today();
    const days = i.dateIn ? Math.max(0, Math.round((new Date(end) - new Date(i.dateIn)) / 864e5)) : 0;
    return { ...i, days, fee: r2(days * (i.dailyRate || 0) * (i.state === 'released' ? 1 : 1)) };
  }
  function view(ent, it) {
    if (ent === 'invoices') return invoiceView(it);
    if (ent === 'contracts') return contractView(it);
    if (ent === 'inventory') return inventoryView(it);
    if (ent === 'parties') return { ...it, jobs: E.jobs.filter((j) => [j.customerId, j.carrierId, j.agentId, j.brokerId].includes(it.id)).length };
    if (ent === 'jobs') return { ...it, assignee: userName(it.assignedTo) };
    if (ent === 'tasks') return { ...it, assigneeName: userName(it.assignee) };
    return it;
  }
  function docVisible(u, d) {
    if (u.role === 'admin') return true;
    if (d.access === 'admin') return false;
    if (d.access === 'managers') return u.role === 'manager';
    return true;
  }

  // ---------- meta ----------
  app.get('/api/erp/meta', wrap(async (req, res) => {
    const u = req.user;
    res.json({ ok: true,
      user: { id: u.id, username: u.username, email: u.email, role: u.role, roleLabel: (E.settings.roles[u.role] || {}).label || u.role,
        partyId: u.partyId || null, branchId: u.branchId || null, fullName: u.fullName || '', phone: u.phone || '', lastLogin: u.lastLogin || null, created: u.created,
        mfa: !!(u.mfa && u.mfa.enabled), must2fa: E.settings.security.require2fa.includes(u.role) && !(u.mfa && u.mfa.enabled) },
      perms: permsOf(u),
      prefs: E.prefs[u.id] || {},
      roles: Object.fromEntries(Object.entries(E.settings.roles).map(([k, v]) => [k, v.label])),
      users: isClient(u) ? [] : ctx.users().filter((x) => x.status === 'active').map((x) => ({ id: x.id, username: x.username, role: x.role || 'viewer', fullName: x.fullName || '' })),
      settings: { company: E.settings.company, base: E.settings.base, currencies: E.settings.currencies, invoice: E.settings.invoice, quality: E.settings.quality, notify: E.settings.notify, security: E.settings.security },
    });
  }));

  // ---------- bulk load ----------
  app.get('/api/erp/bulk', wrap(async (req, res) => {
    const u = req.user;
    if (isClient(u)) return deny(res);
    const out = {};
    for (const ent of String(req.query.e || '').split(',').filter((x) => ENT[x])) {
      if (!can(u, ENT[ent].module, 'r') && !(ent === 'jobs' && can(u, 'customs', 'r')) && !(['parties', 'branches'].includes(ent))) continue;
      let list = E[ent];
      if (ent === 'documents') list = list.filter((d) => docVisible(u, d));
      out[ent] = list.map((it) => view(ent, it));
    }
    if (String(req.query.e || '').includes('events')) out.events = E.events.slice(-400);
    res.json({ ok: true, data: out });
  }));

  // ---------- generic CRUD ----------
  function checkRefs(ent, data) {
    for (const [k, f] of Object.entries(ENT[ent].fields)) {
      if (f.t === 'ref' && data[k] != null && !E[f.ref].some((x) => x.id === data[k])) return `${f.label}: العنصر المحدد غير موجود.`;
      if (f.req && (data[k] == null || data[k] === '') && data[k] !== undefined) return `${f.label} مطلوب.`;
    }
    return null;
  }
  function applyNumbers(ent, item) {
    const num = ENT[ent].num;
    if (!num) return;
    if (ent === 'parties' || ent === 'employees') { item[num.field] = `${num.prefix}-${String(item.id).padStart(num.pad || 6, '0')}`; return; }
    const key = `${num.prefix}-${new Date().getFullYear()}`;
    const n = (E.seq[key] = (E.seq[key] || 0) + 1);
    item[num.field] = `${key}-${String(n).padStart(num.pad || 5, '0')}`;
  }
  function calcTotals(ent, it) {
    if (ent === 'invoices') {
      it.subtotal = r2(lineTotal(it.items));
      const afterDisc = Math.max(0, it.subtotal - (it.discount || 0));
      it.tax = r2(afterDisc * (it.taxRate || 0) / 100);
      it.total = r2(afterDisc + it.tax);
    }
    if (ent === 'quotes' || ent === 'purchases') it.total = r2(lineTotal(it.items));
  }
  const canWrite = (u, ent, act, item) => {
    const mod = ENT[ent].module;
    if (can(u, mod, act)) return true;
    if (ent === 'jobs' && act === 'u' && can(u, 'customs', 'u')) return 'customs';
    if (ent === 'jobs' && act === 'c' && can(u, 'customs', 'c')) return 'customs-create';
    if (ent === 'tasks' && (can(u, 'customs', 'u') || can(u, 'quality', 'u'))) return true;
    if (ent === 'documents' && act === 'c' && Object.values(permsOf(u)).some((p) => p.includes('c'))) return true;
    if (ent === 'trips' && can(u, 'ops', act)) return true;
    return false;
  };
  const CUSTOMS_FIELDS = ['declNo', 'declDate', 'customsOffice', 'customsType', 'channel', 'dutyAmount', 'hsCode', 'brokerId', 'importer', 'importerTax', 'exporter', 'exporterCountry', 'goodsValue', 'goodsCurrency'];

  app.get('/api/erp/e/:ent', wrap(async (req, res) => {
    const ent = req.params.ent; if (!ENT[ent]) return nf(res);
    if (!can(req.user, ENT[ent].module, 'r') && !(ent === 'jobs' && can(req.user, 'customs', 'r'))) return deny(res);
    let list = E[ent];
    if (ent === 'documents') list = list.filter((d) => docVisible(req.user, d));
    res.json({ ok: true, items: list.map((it) => view(ent, it)) });
  }));
  app.get('/api/erp/e/:ent/:id', wrap(async (req, res) => {
    const ent = req.params.ent; if (!ENT[ent]) return nf(res);
    if (!can(req.user, ENT[ent].module, 'r') && !(ent === 'jobs' && can(req.user, 'customs', 'r'))) return deny(res);
    const it = E[ent].find((x) => x.id === +req.params.id); if (!it) return nf(res);
    res.json({ ok: true, item: view(ent, it) });
  }));

  app.post('/api/erp/e/:ent', wrap(async (req, res) => {
    const ent = req.params.ent; if (!ENT[ent]) return nf(res);
    const u = req.user, w = canWrite(u, ent, 'c');
    if (!w) return deny(res);
    const data = clean(ent, req.body || {});
    if (ent === 'jobs' && w === 'customs-create') data.mode = 'CC';
    if (ent === 'movements' && data.type === 'out' && data.inventoryId) {
      const stock = E.inventory.find((x) => x.id === data.inventoryId);
      if (stock) { data.warehouseId = stock.warehouseId; data.partyId = stock.partyId; }
    }
    const err = checkRefs(ent, data); if (err) return bad(res, err);
    const item = { id: nextId(ent), ...data, createdBy: u.id, createdAt: now(), updatedAt: now() };
    // entity specific defaults & side effects
    if (ent === 'jobs') {
      const key = `${item.mode}-${yy()}`; const n = (E.seq[key] = (E.seq[key] || 0) + 1);
      item.no = `${key}-${String(n).padStart(4, '0')}`; item.status = 'draft';
    } else applyNumbers(ent, item);
    if (ent === 'invoices') { if (!item.date) item.date = today(); if (!item.dueDate) { const d = new Date(item.date); d.setDate(d.getDate() + (E.settings.invoice.dueDays || 30)); item.dueDate = d.toISOString().slice(0, 10); } if (item.taxRate == null) item.taxRate = E.settings.invoice.taxRate || 0; }
    if (ent === 'quotes' && !item.date) item.date = today();
    if (ent === 'payments') {
      const inv = E.invoices.find((x) => x.id === item.invoiceId);
      if (!inv || inv.state !== 'issued') return bad(res, 'يمكن تسجيل الدفعات على الفواتير الصادرة فقط.');
      if (!(item.amount > 0)) return bad(res, 'أدخل مبلغاً صحيحاً.');
      const bal = invoiceView(inv).balance;
      if (item.amount > bal + 0.005) return bad(res, `المبلغ أكبر من الرصيد المتبقي (${bal}).`);
      if (!item.date) item.date = today();
    }
    if (ent === 'movements') {
      if (!(item.qty > 0)) return bad(res, 'أدخل كمية صحيحة.');
      if (!item.date) item.date = today();
      if (item.type === 'in') {
        const wh = E.warehouses.find((x) => x.id === item.warehouseId);
        if (!item.partyId) return bad(res, 'اختر العميل.');
        const inv = { id: nextId('inventory'), warehouseId: item.warehouseId, partyId: item.partyId, jobId: null, ref: item.ref, item: item.item, qty: item.qty, unit: item.unit,
          location: item.location, dateIn: item.date, dateOut: '', dailyRate: wh ? (wh.dailyRate || 0) : 0, state: 'stored', createdBy: u.id, createdAt: now(), updatedAt: now() };
        applyNumbers('inventory', inv); E.inventory.push(inv); item.inventoryId = inv.id;
      } else {
        const inv = E.inventory.find((x) => x.id === item.inventoryId);
        if (!inv) return bad(res, 'اختر سجل المخزون المراد تسليمه.');
        if (item.qty > (inv.qty || 0) + 0.0001) return bad(res, `الكمية المتاحة ${inv.qty} فقط.`);
        inv.qty = r2((inv.qty || 0) - item.qty);
        inv.state = inv.qty <= 0 ? 'released' : 'partial';
        if (inv.qty <= 0) inv.dateOut = item.date;
        inv.updatedAt = now();
        item.partyId = inv.partyId; item.warehouseId = inv.warehouseId; item.ref = item.ref || inv.ref; item.item = item.item || inv.item; item.location = item.location || inv.location;
      }
    }
    if (ent === 'trucks' && E.trucks.some((t) => t.plate.toLowerCase() === item.plate.toLowerCase())) return bad(res, 'رقم اللوحة مسجّل مسبقاً.');
    if (ent === 'attendance') {
      const ex = E.attendance.find((a) => a.employeeId === item.employeeId && a.date === item.date);
      if (ex) { Object.assign(ex, data, { updatedAt: now() }); await save(); return res.json({ ok: true, item: ex }); }
    }
    if (ent === 'interactions' && !item.date) item.date = now().slice(0, 16);
    if (ent === 'complaints' && !item.date) item.date = today();
    calcTotals(ent, item);
    E[ent].push(item);
    if (ent === 'jobs') jobEvent(item.id, u, 'create', 'تم إنشاء الشحنة');
    if (ent === 'tasks' && item.jobId) jobEvent(item.jobId, u, 'update', `مهمة جديدة: ${item.title}`);
    if (ent === 'costs') jobEvent(item.jobId, u, 'update', `إضافة تكلفة: ${item.amount} ${item.currency}`);
    if (ent === 'documents' && item.entity === 'jobs' && item.entityId) jobEvent(item.entityId, u, 'update', `رفع مستند: ${item.name}`);
    audit(u, ent, item.id, 'create', item.no || item.code || item.name || item.title || item.plate || '');
    await save();
    res.json({ ok: true, item: view(ent, item) });
  }));

  app.put('/api/erp/e/:ent/:id', wrap(async (req, res) => {
    const ent = req.params.ent; if (!ENT[ent]) return nf(res);
    const u = req.user;
    const it = E[ent].find((x) => x.id === +req.params.id); if (!it) return nf(res);
    const w = canWrite(u, ent, 'u', it);
    if (!w) return deny(res);
    let data = clean(ent, req.body || {}, true);
    if (w === 'customs') data = Object.fromEntries(Object.entries(data).filter(([k]) => CUSTOMS_FIELDS.includes(k)));
    if (ent === 'jobs') delete data.mode;
    if (ent === 'movements' || ent === 'payments') return bad(res, 'لا يمكن تعديل الحركات المالية أو المخزنية. احذفها وأنشئ حركة جديدة.');
    const err = checkRefs(ent, data); if (err) return bad(res, err);
    if (ent === 'invoices' && it.state !== 'draft' && Object.keys(data).some((k) => !['state', 'notes'].includes(k))) return bad(res, 'لا يمكن تعديل فاتورة صادرة. ألغِها وأنشئ فاتورة جديدة.');
    if (ent === 'invoices' && data.state === 'draft' && it.state !== 'draft') return bad(res, 'لا يمكن إرجاع فاتورة صادرة إلى مسودة.');
    if (ent === 'invoices' && data.state === 'cancelled' && E.payments.some((p) => p.invoiceId === it.id)) return bad(res, 'لا يمكن إلغاء فاتورة عليها دفعات.');
    if (ent === 'trucks' && data.plate && E.trucks.some((t) => t.id !== it.id && t.plate.toLowerCase() === data.plate.toLowerCase())) return bad(res, 'رقم اللوحة مسجّل مسبقاً.');
    const changed = Object.keys(data).filter((k) => JSON.stringify(it[k] ?? null) !== JSON.stringify(data[k] ?? null));
    Object.assign(it, data, { updatedAt: now() });
    calcTotals(ent, it);
    if (ent === 'jobs' && changed.length) jobEvent(it.id, u, 'update', `تم تعديل ${changed.length} حقل`);
    if (ent === 'tasks' && 'done' in data && it.jobId && changed.includes('done')) jobEvent(it.jobId, u, 'update', `${data.done ? 'تم إنجاز' : 'أعيد فتح'} مهمة: ${it.title}`);
    if (ent === 'invoices' && changed.includes('state')) audit(u, ent, it.id, 'state', `${it.no}: ${it.state}`);
    audit(u, ent, it.id, 'update', it.no || it.code || it.name || it.title || it.plate || '');
    await save();
    res.json({ ok: true, item: view(ent, it) });
  }));

  app.delete('/api/erp/e/:ent/:id', wrap(async (req, res) => {
    const ent = req.params.ent; if (!ENT[ent]) return nf(res);
    const u = req.user;
    if (!can(u, ENT[ent].module, 'd') && !(ent === 'tasks' && canWrite(u, 'tasks', 'u'))) return deny(res);
    const id = +req.params.id;
    const it = E[ent].find((x) => x.id === id); if (!it) return nf(res);
    // referential integrity
    const refs = [];
    for (const [e2, def] of Object.entries(ENT)) for (const [k, f] of Object.entries(def.fields))
      if (f.t === 'ref' && f.ref === ent && E[e2].some((x) => x[k] === id)) refs.push(def.label);
    if (ent === 'jobs') { // a shipment owns its tasks, costs, trips and events
      const owned = ['tasks', 'costs'];
      if (E.invoices.some((x) => x.jobId === id)) return bad(res, 'لا يمكن حذف شحنة عليها فواتير.');
      owned.forEach((c) => { E[c] = E[c].filter((x) => x.jobId !== id); });
      E.events = E.events.filter((x) => x.jobId !== id);
      E.trips.forEach((t) => { if (t.jobId === id) t.jobId = null; });
      ['inventory', 'quotes', 'complaints', 'expenses'].forEach((c) => E[c].forEach((x) => { if (x.jobId === id) x.jobId = null; }));
    } else if (ent === 'invoices') {
      if (it.state !== 'draft' && u.role !== 'admin') return bad(res, 'يمكن حذف فواتير المسودة فقط.');
      E.payments = E.payments.filter((p) => p.invoiceId !== id);
    } else if (ent === 'payments' || ent === 'movements') {
      if (ent === 'movements') {
        const inv = E.inventory.find((x) => x.id === it.inventoryId);
        if (inv && it.type === 'out') { inv.qty = r2((inv.qty || 0) + it.qty); inv.state = 'stored'; inv.dateOut = ''; }
        if (inv && it.type === 'in') {
          if (E.movements.some((m) => m.inventoryId === inv.id && m.type === 'out')) return bad(res, 'لا يمكن حذف حركة استلام صُرف منها.');
          E.inventory = E.inventory.filter((x) => x.id !== inv.id);
        }
      }
    } else if (refs.length) return bad(res, `لا يمكن الحذف لأنه مرتبط بسجلات (${[...new Set(refs)].join('، ')}). يمكنك تغيير حالته بدلاً من ذلك.`);
    if (ent === 'documents' && it.fileId) { try { fs.unlinkSync(path.join(FILES, it.fileId)); } catch (_) {} }
    E[ent] = E[ent].filter((x) => x.id !== id);
    audit(u, ent, id, 'delete', it.no || it.code || it.name || it.title || it.plate || '');
    await save();
    res.json({ ok: true });
  }));

  // ---------- shipments ----------
  app.get('/api/erp/jobs/:id/full', wrap(async (req, res) => {
    const u = req.user;
    if (!can(u, 'ops', 'r') && !can(u, 'customs', 'r')) return deny(res);
    const j = E.jobs.find((x) => x.id === +req.params.id); if (!j) return nf(res);
    const events = E.events.filter((e) => e.jobId === j.id);
    const flow = SC.JOB_FLOW[SC.family(j.mode)];
    const stages = flow.map((s) => {
      const ev = s === 'draft' ? events.find((e) => e.type === 'create') : events.find((e) => e.type === 'status' && e.to === s);
      return { key: s, at: ev ? ev.at : null, by: ev ? ev.by : null, note: ev ? (ev.note || '') : '' };
    });
    res.json({ ok: true, job: view('jobs', j), stages, events: events.slice().reverse(),
      tasks: E.tasks.filter((t) => t.jobId === j.id).map((t) => view('tasks', t)),
      costs: E.costs.filter((c) => c.jobId === j.id),
      documents: E.documents.filter((d) => d.entity === 'jobs' && d.entityId === j.id && docVisible(u, d)),
      invoices: E.invoices.filter((i) => i.jobId === j.id).map(invoiceView),
      trips: E.trips.filter((t) => t.jobId === j.id) });
  }));
  app.post('/api/erp/jobs/:id/status', wrap(async (req, res) => {
    const u = req.user;
    const j = E.jobs.find((x) => x.id === +req.params.id); if (!j) return nf(res);
    const fam = SC.family(j.mode);
    if (!can(u, 'ops', 'u') && !(fam === 'customs' && can(u, 'customs', 'u'))) return deny(res);
    const st = String(req.body.status || '');
    if (![...SC.JOB_FLOW[fam], 'cancelled'].includes(st)) return bad(res, 'حالة غير صالحة لهذا النوع من الشحنات.');
    if (st === j.status) return res.json({ ok: true, job: view('jobs', j) });
    const from = j.status; j.status = st; j.updatedAt = now();
    if (st === 'sailed' || st === 'in_transit') j.atd = j.atd || today();
    if (st === 'arrived' || st === 'at_border') j.ata = j.ata || today();
    const note = T.str(req.body.note);
    jobEvent(j.id, u, 'status', `${SC.JOB_STATUS[from][0]} ← ${SC.JOB_STATUS[st][0]}`, { from, to: st, note });
    audit(u, 'jobs', j.id, 'status', `${j.no}: ${st}`);
    await save();
    res.json({ ok: true, job: view('jobs', j) });
  }));
  app.post('/api/erp/jobs/:id/note', wrap(async (req, res) => {
    const u = req.user;
    if (!can(u, 'ops', 'r') && !can(u, 'customs', 'r')) return deny(res);
    const j = E.jobs.find((x) => x.id === +req.params.id); if (!j) return nf(res);
    const title = T.str(req.body.title), text = T.text(req.body.text);
    if (!text) return bad(res, 'اكتب نص الملاحظة.');
    const priority = ['low', 'medium', 'high'].includes(req.body.priority) ? req.body.priority : 'medium';
    const category = ['general', 'customs', 'delivery', 'customer', 'docs'].includes(req.body.category) ? req.body.category : 'general';
    jobEvent(j.id, u, 'comment', text, { title, priority, category });
    await save();
    res.json({ ok: true });
  }));
  app.post('/api/erp/jobs/:id/duplicate', wrap(async (req, res) => {
    const u = req.user; if (!can(u, 'ops', 'c')) return deny(res);
    const j = E.jobs.find((x) => x.id === +req.params.id); if (!j) return nf(res);
    const copy = { ...j, id: nextId('jobs'), status: 'draft', atd: '', ata: '', etd: '', eta: '', declNo: '', mbl: '', hbl: '', cmr: '', bookingNo: '', containers: [], createdBy: u.id, createdAt: now(), updatedAt: now() };
    const key = `${copy.mode}-${yy()}`; const n = (E.seq[key] = (E.seq[key] || 0) + 1); copy.no = `${key}-${String(n).padStart(4, '0')}`;
    E.jobs.push(copy); jobEvent(copy.id, u, 'create', `تم إنشاء الشحنة كنسخة من ${j.no}`); audit(u, 'jobs', copy.id, 'create', copy.no); await save();
    res.json({ ok: true, item: view('jobs', copy) });
  }));
  app.post('/api/erp/quotes/:id/convert', wrap(async (req, res) => {
    const u = req.user; if (!can(u, 'ops', 'c') && !can(u, 'crm', 'u')) return deny(res);
    const q = E.quotes.find((x) => x.id === +req.params.id); if (!q) return nf(res);
    if (q.jobId) return bad(res, 'تم تحويل هذا العرض مسبقاً.');
    const mode = SC.MODES.map((m) => m[0]).includes(q.mode) ? q.mode : 'SI';
    const job = { id: nextId('jobs'), mode, customerId: q.partyId, origin: q.origin, destination: q.destination, cargo: q.cargo, priority: 'normal', containers: [], status: 'draft', createdBy: u.id, createdAt: now(), updatedAt: now() };
    const key = `${mode}-${yy()}`; const n = (E.seq[key] = (E.seq[key] || 0) + 1); job.no = `${key}-${String(n).padStart(4, '0')}`;
    E.jobs.push(job); q.jobId = job.id; q.status = 'accepted'; q.updatedAt = now();
    jobEvent(job.id, u, 'create', `تم إنشاء الشحنة من عرض السعر ${q.no}`); audit(u, 'quotes', q.id, 'convert', q.no); await save();
    res.json({ ok: true, job: view('jobs', job) });
  }));
  app.post('/api/erp/jobs/:id/invoice', wrap(async (req, res) => {
    const u = req.user; if (!can(u, 'finance', 'c')) return deny(res);
    const j = E.jobs.find((x) => x.id === +req.params.id); if (!j) return nf(res);
    const inv = { id: nextId('invoices'), partyId: j.customerId, jobId: j.id, date: today(), currency: 'USD', items: [], discount: 0, taxRate: E.settings.invoice.taxRate || 0, state: 'draft', notes: '', createdBy: u.id, createdAt: now(), updatedAt: now() };
    const d = new Date(); d.setDate(d.getDate() + (E.settings.invoice.dueDays || 30)); inv.dueDate = d.toISOString().slice(0, 10);
    applyNumbers('invoices', inv); calcTotals('invoices', inv); E.invoices.push(inv); audit(u, 'invoices', inv.id, 'create', inv.no); await save();
    res.json({ ok: true, item: invoiceView(inv) });
  }));

  // ---------- files ----------
  const MIMES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls' };
  const express = require('express');
  app.post('/api/erp/files', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
    const u = req.user;
    const mime = String(req.headers['content-type'] || '').split(';')[0];
    if (!MIMES[mime]) return bad(res, 'نوع الملف غير مدعوم. المسموح: PDF, DOCX, XLSX, PPTX, JPG, PNG.');
    if (!req.body || !req.body.length) return bad(res, 'الملف فارغ.');
    const id = crypto.randomBytes(12).toString('hex') + '.' + MIMES[mime];
    fs.writeFileSync(path.join(FILES, id), req.body);
    let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).slice(0, 200); } catch (_) {}
    audit(u, 'files', 0, 'upload', name);
    res.json({ ok: true, fileId: id, size: req.body.length, mime, name });
  }));
  app.get('/api/erp/files/:id', wrap(async (req, res) => {
    const u = req.user, id = String(req.params.id);
    if (!/^[a-f0-9]{24}\.[a-z]{3,4}$/.test(id)) return nf(res);
    const doc = E.documents.find((d) => d.fileId === id);
    if (!doc) return nf(res);
    if (isClient(u)) {
      const mine = (doc.entity === 'parties' && doc.entityId === u.partyId) || (doc.entity === 'jobs' && E.jobs.some((j) => j.id === doc.entityId && j.customerId === u.partyId));
      if (!mine || !['client', 'all'].includes(doc.access || 'all')) return deny(res);
    } else if (!docVisible(u, doc)) return deny(res);
    const p = path.join(FILES, id); if (!fs.existsSync(p)) return nf(res);
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(doc.fileName || id)}`);
    fs.createReadStream(p).pipe(res);
  }));

  // ---------- customer portal ----------
  app.get('/api/erp/portal', wrap(async (req, res) => {
    const u = req.user;
    const partyId = isClient(u) ? u.partyId : (can(u, 'crm', 'r') ? +req.query.partyId : null);
    if (!partyId) return bad(res, isClient(u) ? 'حسابك غير مرتبط بعميل بعد. تواصل مع الشركة.' : 'اختر العميل لمعاينة البوابة.');
    const party = E.parties.find((p) => p.id === partyId); if (!party) return nf(res);
    const jobs = E.jobs.filter((j) => j.customerId === partyId);
    const jobIds = jobs.map((j) => j.id);
    res.json({ ok: true, party: { id: party.id, name: party.name, code: party.code },
      jobs: jobs.map((j) => ({ id: j.id, no: j.no, mode: j.mode, status: j.status, origin: j.origin, destination: j.destination, originCountry: j.originCountry, destCountry: j.destCountry, etd: j.etd, eta: j.eta, ata: j.ata, containers: (j.containers || []).map((c) => c.no) })),
      invoices: E.invoices.filter((i) => i.partyId === partyId && i.state === 'issued').map(invoiceView).map((i) => ({ id: i.id, no: i.no, date: i.date, dueDate: i.dueDate, total: i.total, paid: i.paid, balance: i.balance, currency: i.currency, status: i.status })),
      contracts: E.contracts.filter((c) => c.partyId === partyId).map(contractView).map((c) => ({ id: c.id, no: c.no, title: c.title, type: c.type, start: c.start, end: c.end, status: c.status })),
      documents: E.documents.filter((d) => ((d.entity === 'parties' && d.entityId === partyId) || (d.entity === 'jobs' && jobIds.includes(d.entityId))) && ['client', 'all'].includes(d.access || 'all'))
        .map((d) => ({ id: d.id, no: d.no, name: d.name, type: d.type, fileId: d.fileId, fileName: d.fileName, createdAt: d.createdAt })),
      quotes: E.quotes.filter((q) => q.partyId === partyId).map((q) => ({ id: q.id, no: q.no, date: q.date, status: q.status, total: q.total, currency: q.currency, origin: q.origin, destination: q.destination })) });
  }));
  app.post('/api/erp/portal/quote', wrap(async (req, res) => {
    const u = req.user; if (!isClient(u) || !u.partyId) return deny(res);
    const q = { id: nextId('quotes'), partyId: u.partyId, date: today(), mode: SC.MODES.map((m) => m[0]).includes(req.body.mode) ? req.body.mode : 'SI',
      origin: T.str(req.body.origin), destination: T.str(req.body.destination), cargo: T.text(req.body.cargo), currency: 'USD', items: [], total: 0, status: 'requested',
      notes: T.text(req.body.notes), createdBy: u.id, createdAt: now(), updatedAt: now() };
    if (!q.origin || !q.destination) return bad(res, 'حدد مكان الانطلاق والوجهة.');
    applyNumbers('quotes', q); E.quotes.push(q); audit(u, 'quotes', q.id, 'portal-request', q.no); await save();
    res.json({ ok: true, item: q });
  }));
  app.post('/api/erp/portal/document', wrap(async (req, res) => {
    const u = req.user; if (!isClient(u) || !u.partyId) return deny(res);
    const b = req.body || {};
    if (!b.fileId || !fs.existsSync(path.join(FILES, String(b.fileId)))) return bad(res, 'ارفع الملف أولاً.');
    const d = { id: nextId('documents'), name: T.str(b.name) || T.str(b.fileName), type: 'shipping', entity: 'parties', entityId: u.partyId, ref: T.str(b.ref), version: '1.0', issueDate: today(), expiryDate: '',
      state: 'review', access: 'client', fileId: String(b.fileId), fileName: T.str(b.fileName), size: T.int(b.size), mime: T.str(b.mime), notes: 'مرفوع من بوابة العميل', createdBy: u.id, createdAt: now(), updatedAt: now() };
    applyNumbers('documents', d); E.documents.push(d); audit(u, 'documents', d.id, 'portal-upload', d.name); await save();
    res.json({ ok: true, item: d });
  }));

  // ---------- users, roles, settings (admin) ----------
  const adminOnly = (req, res) => { if (req.user.role !== 'admin' && !(req.user.role === 'manager' && req.method === 'GET')) { deny(res, 'هذه الصفحة لمدير النظام فقط.'); return false; } return true; };
  app.get('/api/erp/users', wrap(async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ ok: true, items: ctx.users().map((u) => ({ id: u.id, username: u.username, email: u.email, fullName: u.fullName || '', phone: u.phone || '', role: u.role || 'viewer', status: u.status,
      branchId: u.branchId || null, partyId: u.partyId || null, created: u.created, lastLogin: u.lastLogin || null,
      mfa: !!(u.mfa && u.mfa.enabled), locked: !!(u.lockUntil && u.lockUntil > Date.now()) })) });
  }));
  app.post('/api/erp/users', wrap(async (req, res) => {
    if (!adminOnly(req, res)) return;
    const b = req.body || {};
    const username = T.str(b.username), email = T.str(b.email), password = String(b.password || '');
    if (!/^[\p{L}\p{N}_.]{3,30}$/u.test(username)) return bad(res, 'اسم المستخدم من 3 إلى 30 حرفاً أو رقماً بدون مسافات.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'أدخل بريداً إلكترونياً صحيحاً.');
    const pe = ctx.passwordError(password, username); if (pe) return bad(res, pe);
    const users = ctx.users();
    if (users.some((x) => x.username.toLowerCase() === username.toLowerCase())) return bad(res, 'اسم المستخدم مستخدم مسبقاً.');
    if (users.some((x) => x.email.toLowerCase() === email.toLowerCase())) return bad(res, 'البريد مسجّل مسبقاً.');
    const role = E.settings.roles[b.role] ? b.role : 'viewer';
    if (role === 'client' && !E.parties.some((p) => p.id === T.int(b.partyId))) return bad(res, 'اختر العميل المرتبط بحساب البوابة.');
    const u = ctx.createUser({ username, email, password, role, status: b.status === 'disabled' ? 'disabled' : 'active', fullName: T.str(b.fullName), phone: T.str(b.phone), branchId: T.int(b.branchId), partyId: role === 'client' ? T.int(b.partyId) : null });
    await ctx.saveUsers(); audit(req.user, 'users', u.id, 'create', username); await save();
    res.json({ ok: true, id: u.id });
  }));
  app.put('/api/erp/users/:id', wrap(async (req, res) => {
    if (!adminOnly(req, res)) return;
    const u = ctx.users().find((x) => x.id === +req.params.id); if (!u) return nf(res);
    const b = req.body || {};
    const admins = ctx.users().filter((x) => x.role === 'admin' && x.status === 'active');
    const losing = u.role === 'admin' && ((b.role && b.role !== 'admin') || b.status === 'disabled');
    if (losing && admins.length <= 1) return bad(res, 'لا يمكن إزالة آخر مدير للنظام.');
    if (b.role) { if (!E.settings.roles[b.role]) return bad(res, 'دور غير صالح.'); u.role = b.role; }
    if (u.role === 'client') { const pid = T.int(b.partyId ?? u.partyId); if (!E.parties.some((p) => p.id === pid)) return bad(res, 'اختر العميل المرتبط بحساب البوابة.'); u.partyId = pid; }
    if (b.status === 'disabled' || b.status === 'active') { if (u.status === 'pending' && b.status === 'active') return bad(res, 'هذا الحساب لم يُفعّل برمز التفعيل بعد.'); if (u.status !== 'pending') u.status = b.status; if (u.status === 'disabled') ctx.revokeSessions(u.id); }
    if (b.resetMfa) { u.mfa = null; delete u.mfaPending; }
    if (b.unlock) { u.lockUntil = 0; u.failCount = 0; }
    if ('fullName' in b) u.fullName = T.str(b.fullName);
    if ('phone' in b) u.phone = T.str(b.phone);
    if ('branchId' in b) u.branchId = T.int(b.branchId);
    if (b.password) { const pe = ctx.passwordError(b.password, u.username); if (pe) return bad(res, pe); u.pass = ctx.hashPass(String(b.password)); ctx.revokeSessions(u.id); }
    await ctx.saveUsers(); audit(req.user, 'users', u.id, 'update', u.username); await save();
    res.json({ ok: true });
  }));
  app.get('/api/erp/users/:id/audit', wrap(async (req, res) => {
    if (!adminOnly(req, res)) return;
    const u = ctx.users().find((x) => x.id === +req.params.id); if (!u) return nf(res);
    res.json({ ok: true, items: E.audit.filter((a) => a.by === u.username).slice(-100).reverse(), logins: ctx.loginLog ? ctx.loginLog(u.id) : [] });
  }));
  app.get('/api/erp/roles', wrap(async (req, res) => { if (!adminOnly(req, res)) return; res.json({ ok: true, roles: E.settings.roles, modules: SC.MODULES }); }));
  app.put('/api/erp/roles', wrap(async (req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    const input = req.body.roles || {};
    for (const [r, def] of Object.entries(input)) {
      if (r === 'admin') continue;
      if (!E.settings.roles[r]) { if (!/^[a-z_]{3,20}$/.test(r)) continue; E.settings.roles[r] = { label: T.str(def.label) || r, perms: {} }; }
      if (def.label) E.settings.roles[r].label = T.str(def.label);
      if (r === 'client') continue;
      for (const m of MODULE_KEYS) E.settings.roles[r].perms[m] = String((def.perms || {})[m] || '').replace(/[^rcud]/g, '').split('').filter((c, i, a) => a.indexOf(c) === i).join('');
    }
    audit(req.user, 'roles', 0, 'update', 'مصفوفة الصلاحيات'); await save();
    res.json({ ok: true, roles: E.settings.roles });
  }));
  app.put('/api/erp/settings', wrap(async (req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    const b = req.body || {};
    if (b.company) for (const k of Object.keys(DEF_SETTINGS.company)) if (k in b.company) E.settings.company[k] = T.str(b.company[k]);
    if (Array.isArray(b.currencies)) E.settings.currencies = b.currencies.filter((c) => /^[A-Z]{3}$/.test(c[0]) && Number(c[1]) > 0).map((c) => [c[0], Number(c[1])]);
    if (b.invoice) { const i = b.invoice; E.settings.invoice = { taxRate: T.num(i.taxRate) || 0, dueDays: T.int(i.dueDays) || 30, terms: T.text(i.terms), bankName: T.str(i.bankName), iban: T.str(i.iban), account: T.str(i.account) }; }
    if (b.notify) for (const k of Object.keys(DEF_SETTINGS.notify)) E.settings.notify[k] = !!b.notify[k];
    if (b.security && Array.isArray(b.security.require2fa)) E.settings.security = { require2fa: b.security.require2fa.filter((r) => E.settings.roles[r] && r !== 'client') };
    if (b.quality) { const q = b.quality; E.settings.quality = { satisfaction: T.num(q.satisfaction) ?? 90, audit: { progress: Math.max(0, Math.min(100, T.int(q.audit?.progress) ?? 0)), date: T.date(q.audit?.date), next: T.date(q.audit?.next),
      steps: (q.audit?.steps || []).slice(0, 8).map((s) => [T.str(s[0]), !!s[1]]) } }; }
    audit(req.user, 'settings', 0, 'update', 'إعدادات النظام'); await save();
    res.json({ ok: true });
  }));

  // ---------- profile ----------
  app.put('/api/erp/me', wrap(async (req, res) => {
    const u = req.user, b = req.body || {};
    if ('fullName' in b) u.fullName = T.str(b.fullName);
    if ('phone' in b) u.phone = T.str(b.phone);
    const p = E.prefs[u.id] || (E.prefs[u.id] = {});
    if (b.prefs) for (const k of ['currency', 'lang', 'tz', 'favorites', 'notif', 'readAll', 'readKeys']) if (k in b.prefs) p[k] = b.prefs[k];
    if (Array.isArray(p.readKeys) && p.readKeys.length > 500) p.readKeys = p.readKeys.slice(-500);
    await ctx.saveUsers(); await save();
    res.json({ ok: true, prefs: p });
  }));
  app.post('/api/erp/me/password', wrap(async (req, res) => {
    const u = req.user, b = req.body || {};
    if (!ctx.checkPass(String(b.current || ''), u.pass)) return bad(res, 'كلمة المرور الحالية غير صحيحة.');
    const pe = ctx.passwordError(b.password, u.username); if (pe) return bad(res, pe);
    u.pass = ctx.hashPass(String(b.password)); ctx.revokeSessions(u.id, req.sessionId); await ctx.saveUsers(); audit(u, 'users', u.id, 'password', 'تغيير كلمة المرور'); await save();
    res.json({ ok: true });
  }));

  // ---------- backup ----------
  app.get('/api/erp/backup', wrap(async (req, res) => {
    if (req.user.role !== 'admin') return deny(res);
    res.setHeader('Content-Disposition', `attachment; filename="safa-erp-backup-${today()}.json"`);
    res.json({ exportedAt: now(), erp: E });
  }));
};
