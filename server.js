// Safa Shipping Console — Node.js server
// Serves the app, the authentication API (/api/auth) and the ERP API (/api/erp).
'use strict';
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const createStore = require('./store');

// ================= configuration =================
// Values come from environment variables; a local .env file is read for convenience (never overrides real env).
(function loadEnvFile() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();
const env = process.env;
const CFG = {
  NODE_ENV: env.NODE_ENV || 'development',
  PORT: +(env.PORT || 3000),
  APP_NAME: env.SITE_NAME || 'Safa Shipping Console',
  ADMIN_EMAIL: env.ADMIN_EMAIL || 'safabakr6.2@gmail.com',
  DATABASE_URL: env.DATABASE_URL || '',
  DATA_DIR: env.DATA_DIR || path.join(__dirname, 'data'),
  SMTP_HOST: env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: +(env.SMTP_PORT || 587),
  SMTP_USER: env.SMTP_USER || 'safabakr6.2@gmail.com',
  SMTP_PASS: (env.SMTP_PASS || '').replace(/\s+/g, ''),
  MAIL_FROM: env.MAIL_FROM || '',
  TRUST_PROXY: env.TRUST_PROXY || '1',
  SIGNUP_CODE_MINUTES: 1440,
  RESET_CODE_MINUTES: 15,
  SESSION_DAYS: +(env.SESSION_DAYS || 30),       // absolute session lifetime
  SESSION_IDLE_DAYS: +(env.SESSION_IDLE_DAYS || 14), // signed out after this much inactivity
  LOCK_AFTER: 5, LOCK_MINUTES: 15,
};
const PROD = CFG.NODE_ENV === 'production';
const VERSION = (() => { try { return require('./package.json').version; } catch (_) { return '0'; } })();
fs.mkdirSync(CFG.DATA_DIR, { recursive: true });

const SECRET = env.SESSION_SECRET || (() => {
  const f = path.join(CFG.DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, s, { mode: 0o600 }); return s; }
})();
if (PROD && !env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET is not set; using data/secret.key. Set it in .env for production.');

// ================= crypto helpers =================
const lc = (s) => String(s || '').trim().toLowerCase();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function hashPass(p) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(p, salt, 64).toString('hex')}`; }
function checkPass(p, stored) {
  const [salt, h] = String(stored || '').split(':'); if (!salt || !h) return false;
  const a = crypto.scryptSync(String(p), salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passwordError(p, username = '') {
  p = String(p || '');
  if (p.length < 8) return 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.';
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) return 'كلمة المرور يجب أن تحتوي على حروف وأرقام معاً.';
  if (username && lc(p).includes(lc(username))) return 'كلمة المرور يجب ألا تحتوي على اسم المستخدم.';
  if (/^(12345678|password|qwerty12|11111111|00000000|abc12345)$/i.test(p)) return 'كلمة المرور سهلة التخمين، اختر كلمة أقوى.';
  return null;
}
// AES-256-GCM for secrets at rest (2FA keys)
const encKey = crypto.createHash('sha256').update(SECRET + ':enc').digest();
function encrypt(txt) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey, iv); const d = Buffer.concat([c.update(txt, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString('base64url')).join('.'); }
function decrypt(s) { const [iv, tag, d] = String(s).split('.').map((x) => Buffer.from(x, 'base64url')); const c = crypto.createDecipheriv('aes-256-gcm', encKey, iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); }

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32dec = (s) => { let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totpAt(secret, step) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
function totpCheck(secret, code, lastStep = 0) {
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) { const st = now + d; if (st > lastStep && totpAt(secret, st) === code) return st; }
  return 0;
}

// ================= mail =================
const transporter = CFG.SMTP_PASS ? nodemailer.createTransport({ host: CFG.SMTP_HOST, port: CFG.SMTP_PORT, secure: CFG.SMTP_PORT === 465, auth: { user: CFG.SMTP_USER, pass: CFG.SMTP_PASS } }) : null;
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mailWrap = (title, body) => `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#E6EDF2;padding:24px">
  <div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D6E0E7">
  <div style="background:#0E2A3B;color:#fff;padding:18px 22px;font-size:17px;font-weight:bold">⚓ ${escH(CFG.APP_NAME)}</div>
  <div style="padding:22px;color:#14232E;font-size:15px;line-height:1.8"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}</div></div></div>`;
const codeBox = (c) => `<div style="font-size:30px;letter-spacing:8px;font-weight:bold;text-align:center;background:#FBF1D6;border-radius:10px;padding:14px;margin:16px 0;direction:ltr">${c}</div>`;
async function sendMail(to, subject, html) {
  if (!transporter) {
    const text = html.replace(/<br>|<\/p>|<\/div>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n\s*\n+/g, '\n');
    const entry = `=== ${new Date().toISOString()} TO: ${to} | ${subject}\n${text}\n`;
    fs.appendFileSync(path.join(CFG.DATA_DIR, 'mail.log'), entry);
    console.log('[mail — SMTP_PASS not set, email written to data/mail.log]');
    return true;
  }
  try { await transporter.sendMail({ from: CFG.MAIL_FROM || `"${CFG.APP_NAME}" <${CFG.SMTP_USER}>`, to, subject, html }); return true; }
  catch (e) { console.error('[mail] error:', e.message); return false; }
}

// ================= app bootstrap =================
async function start() {
  const store = createStore({ dataDir: CFG.DATA_DIR, databaseUrl: CFG.DATABASE_URL });
  await store.init();
  const AUTH = await store.open('auth', { file: path.join(CFG.DATA_DIR, 'users.db'), defaults: { nextId: 1, users: [], codes: {}, sessions: [], logins: [] } });
  const DB = AUTH.state;
  for (const k of ['users', 'sessions', 'logins']) if (!Array.isArray(DB[k])) DB[k] = [];
  if (!DB.codes || typeof DB.codes !== 'object') DB.codes = {};
  const seq = (k) => (DB['seq_' + k] = Math.max(DB['seq_' + k] || 0, ...DB[k].map((x) => x.id), 0) + 1);
  async function save() {
    try { await AUTH.save(); } catch (e) { console.error('[db] auth save failed (changes rolled back):', e.message); const err = new Error('DBSAVE'); err.status = 503; throw err; }
  }
  const saveSoon = () => save().catch(() => {});

  const byName = (n) => DB.users.find((u) => lc(u.username) === lc(n));
  const byEmail = (e) => DB.users.find((u) => lc(u.email) === lc(e));
  const byId = (id) => DB.users.find((u) => u.id === id);

  // ---------- sessions (server-side, revocable) ----------
  const cookieOf = (req, name) => { const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '=')); return raw ? decodeURIComponent(raw.slice(name.length + 1)) : ''; };
  const cookie = (req, name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
  function setCookies(res, list) { const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), ...list]); }
  function createSession(req, res, u) {
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    DB.sessions.push({ id: seq('sessions'), tok: sha256(token), uid: u.id, created: now, lastSeen: now, exp: now + CFG.SESSION_DAYS * 864e5,
      ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 160) });
    const mine = DB.sessions.filter((x) => x.uid === u.id); if (mine.length > 20) { const drop = new Set(mine.sort((a, b) => a.lastSeen - b.lastSeen).slice(0, mine.length - 20).map((x) => x.id)); DB.sessions = DB.sessions.filter((x) => !drop.has(x.id)); }
    setCookies(res, [cookie(req, 'safa_sid', token, CFG.SESSION_DAYS * 86400), cookie(req, 'safa_flow', '', 0)]);
  }
  function sessionOf(req) {
    const t = cookieOf(req, 'safa_sid'); if (!t) return null;
    const h = sha256(t), now = Date.now();
    const s = DB.sessions.find((x) => x.tok === h); if (!s) return null;
    if (s.exp < now || now - s.lastSeen > CFG.SESSION_IDLE_DAYS * 864e5) return null;
    const u = byId(s.uid); if (!u || u.status !== 'active') return null;
    if (now - s.lastSeen > 5 * 60000) { s.lastSeen = now; s.ip = req.ip; saveSoon(); }
    return { s, u };
  }
  function revokeSessions(uid, exceptId) { DB.sessions = DB.sessions.filter((s) => s.uid !== uid || s.id === exceptId); }
  function pruneSessions() { const now = Date.now(); const before = DB.sessions.length; DB.sessions = DB.sessions.filter((s) => s.exp > now && now - s.lastSeen < CFG.SESSION_IDLE_DAYS * 864e5); if (DB.logins.length > 3000) DB.logins.splice(0, DB.logins.length - 3000); return before !== DB.sessions.length; }
  // short-lived signed "flow" cookie for multi-step auth (pending signup, password reset, 2FA step)
  function readFlow(req) { const raw = cookieOf(req, 'safa_flow'); const [b, sig] = raw.split('.'); if (!b || !sig || hmac(b) !== sig) return {}; try { const f = JSON.parse(Buffer.from(b, 'base64url').toString()); return f.exp > Date.now() ? f : {}; } catch (_) { return {}; } }
  function writeFlow(req, res, data, minutes = 30) { const b = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + minutes * 60000 })).toString('base64url'); setCookies(res, [cookie(req, 'safa_flow', `${b}.${hmac(b)}`, minutes * 60)]); }
  // one-time upgrade of the previous signed-cookie sessions so nobody is signed out by the update
  function legacySession(req, res) {
    const raw = cookieOf(req, 'safa_sess'); if (!raw) return null;
    const [b, sig] = raw.split('.'); setCookies(res, [cookie(req, 'safa_sess', '', 0)]);
    if (!b || !sig || hmac(b) !== sig) return null;
    try { const s = JSON.parse(Buffer.from(b, 'base64url').toString()); const u = s.exp > Date.now() && byId(s.uid); if (u && u.status === 'active') { createSession(req, res, u); saveSoon(); return u; } } catch (_) {}
    return null;
  }
  function logLogin(req, u, ok, reason, name) {
    DB.logins.push({ id: seq('logins'), at: new Date().toISOString(), uid: u ? u.id : null, username: u ? u.username : String(name || '').slice(0, 60), ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 160), ok, reason });
  }

  // ---------- throttle (per IP, in memory) ----------
  const TH = new Map();
  function throttle(req, action, max, windowSec) {
    const k = `${action}:${req.ip}`, now = Date.now(), r = TH.get(k);
    if (!r || now - r.since > windowSec * 1000) { TH.set(k, { n: 1, since: now }); return null; }
    if (r.n >= max) return 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.';
    r.n++; return null;
  }
  // failure-only counters: an office behind one shared IP is never blocked by normal logins
  const FAIL = new Map();
  const failBlocked = (req, action, max) => { const r = FAIL.get(`${action}:${req.ip}`); return r && Date.now() - r.since < 900e3 && r.n >= max ? 'محاولات خاطئة كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مرة أخرى.' : null; };
  const failHit = (req, action) => { const k = `${action}:${req.ip}`, now = Date.now(), r = FAIL.get(k); if (!r || now - r.since > 900e3) FAIL.set(k, { n: 1, since: now }); else r.n++; };
  setInterval(() => { const now = Date.now(); for (const [k, r] of FAIL) if (now - r.since > 900e3) FAIL.delete(k); }, 10 * 60000).unref();
  setInterval(() => { const now = Date.now(); for (const [k, r] of TH) if (now - r.since > 3600e3) TH.delete(k); if (pruneSessions()) saveSoon(); }, 10 * 60000).unref();

  // ---------- one-time codes ----------
  function newCode(uid, purpose, minutes) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    DB.codes[`${uid}:${purpose}`] = { h: hmac(`${uid}:${purpose}:${code}`), exp: Date.now() + minutes * 60000, attempts: 0, sent: Date.now() };
    return code;
  }
  function checkCode(uid, purpose, code) {
    const k = `${uid}:${purpose}`, c = DB.codes[k];
    if (!c) return 'لا يوجد رمز فعّال. اطلب رمزاً جديداً.';
    if (c.exp < Date.now()) return 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.';
    if (c.attempts >= 5) return 'تجاوزت عدد المحاولات المسموح. اطلب رمزاً جديداً.';
    if (c.h !== hmac(`${uid}:${purpose}:${code}`)) { c.attempts++; const left = 5 - c.attempts; return left > 0 ? `الرمز غير صحيح. بقي لك ${left} محاولات.` : 'الرمز غير صحيح. اطلب رمزاً جديداً.'; }
    delete DB.codes[k]; return null;
  }
  function cooldown(uid, purpose, sec = 60) { const c = DB.codes[`${uid}:${purpose}`]; return c && Date.now() - c.sent < sec * 1000 ? `انتظر ${Math.ceil(sec - (Date.now() - c.sent) / 1000)} ثانية قبل طلب رمز جديد.` : null; }
  function signupMail(u, code) {
    const mailto = `mailto:${encodeURIComponent(u.email)}?subject=${encodeURIComponent('رمز تفعيل حسابك - ' + CFG.APP_NAME)}&body=${encodeURIComponent(`مرحباً ${u.username}،\n\nرمز تفعيل حسابك في ${CFG.APP_NAME} هو: ${code}\n\nأدخله في صفحة التفعيل لإكمال التسجيل.`)}`;
    return sendMail(CFG.ADMIN_EMAIL, `طلب تسجيل جديد: ${u.username}`, mailWrap('طلب تسجيل جديد', `<p>وصل طلب تسجيل جديد:</p>
      <p><b>اسم المستخدم:</b> ${escH(u.username)}<br><b>البريد:</b> <span dir="ltr">${escH(u.email)}</span></p><p>رمز التفعيل:</p>${codeBox(code)}
      <p>إذا وافقت على الطلب، أرسل هذا الرمز إلى بريد المستخدم. الرمز صالح لمدة ${CFG.SIGNUP_CODE_MINUTES / 60} ساعة.</p>
      <p style="text-align:center"><a href="${escH(mailto)}" style="display:inline-block;background:#0E2A3B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px">إرسال الرمز إلى المستخدم</a></p>
      <p style="color:#5E7282;font-size:13px">إذا لم توافق، تجاهل هذه الرسالة ولن يتمكن من الدخول.</p>`));
  }

  // ================= express =================
  const app = express();
  app.set('trust proxy', /^\d+$/.test(CFG.TRUST_PROXY) ? +CFG.TRUST_PROXY : CFG.TRUST_PROXY);
  app.disable('x-powered-by');

  // security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (req.secure && PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  // CSRF protection: state-changing API calls must come from this site
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const o = req.headers.origin || req.headers.referer;
    if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ ok: false, error: 'طلب مرفوض (مصدر غير موثوق).' }); } catch (_) { return res.status(403).json({ ok: false, error: 'طلب مرفوض.' }); } }
    next();
  });
  // API request log (errors and slow calls)
  app.use('/api', (req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => { const ms = Date.now() - t0; if (res.statusCode >= 500 || ms > 2000) console.log(`[api] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms}ms`); });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use((err, req, res, next) => { if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'بيانات غير صالحة.' }); if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'حجم البيانات كبير جداً.' }); next(err); });

  app.get('/healthz', async (req, res) => { const h = await store.health(); res.status(h.ok ? 200 : 503).json({ ok: h.ok, db: h.db, version: VERSION, uptime: Math.round(process.uptime()) }); });

  const pub = (u) => ({ username: u.username, email: u.email, role: u.role || '' });
  async function finishLogin(req, res, u) { u.lastLogin = Date.now(); u.failCount = 0; u.lockUntil = 0; createSession(req, res, u); logLogin(req, u, true, 'ok'); await save(); }

  // ---------- authentication API ----------
  app.all(['/api/auth.php', '/api/auth'], async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ok = (d) => res.json({ ok: true, ...d });
    const fail = (error, code = 400, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
    const action = req.query.action || '';
    const b = req.body || {};
    const s = (k) => String(b[k] ?? '').trim();
    const flow = readFlow(req);
    if (!['me', 'sessions'].includes(action) && req.method !== 'POST') return fail('Method not allowed', 405);
    let t;
    try {
      switch (action) {
        case 'me': {
          const cur = sessionOf(req); if (cur) return ok({ user: pub(cur.u) });
          const lu = legacySession(req, res); return lu ? ok({ user: pub(lu) }) : res.json({ ok: false, user: null });
        }
        case 'register': {
          if ((t = throttle(req, 'register', 5, 3600))) return fail(t, 429);
          const username = s('username'), email = s('email'), pass = String(b.password || '');
          if (!/^[\p{L}\p{N}_.]{3,30}$/u.test(username)) return fail('اسم المستخدم يجب أن يكون من 3 إلى 30 حرفاً أو رقماً بدون مسافات.', 422, { field: 'username' });
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('أدخل بريداً إلكترونياً صحيحاً.', 422, { field: 'email' });
          const pe = passwordError(pass, username); if (pe) return fail(pe, 422, { field: 'password' });
          const exU = byName(username), exE = byEmail(email);
          if (exU && exU.status !== 'pending') return fail('اسم المستخدم مستخدم مسبقاً.', 409, { field: 'username' });
          if (exE && exE.status !== 'pending') return fail('هذا البريد مسجّل مسبقاً. سجّل الدخول أو أعد تعيين كلمة المرور.', 409, { field: 'email' });
          for (const old of [exU, exE]) if (old && old.status === 'pending') { DB.users = DB.users.filter((x) => x.id !== old.id); delete DB.codes[`${old.id}:signup`]; }
          const u = { id: DB.nextId++, username, email, pass: hashPass(pass), status: 'pending', created: Date.now() };
          DB.users.push(u);
          const code = newCode(u.id, 'signup', CFG.SIGNUP_CODE_MINUTES);
          await save();
          if (!(await signupMail(u, code))) return fail('تعذّر إرسال الطلب حالياً. حاول مرة أخرى بعد قليل.', 502);
          writeFlow(req, res, { pending: u.id }, CFG.SIGNUP_CODE_MINUTES);
          return ok({ next: 'verify', email: u.email });
        }
        case 'verify': {
          if ((t = throttle(req, 'verify', 20, 900))) return fail(t, 429);
          const uid = flow.pending;
          if (!uid) return fail('انتهت الجلسة. سجّل الدخول باسم المستخدم وكلمة المرور ثم أدخل الرمز.');
          const code = s('code').replace(/\D/g, '');
          if (code.length !== 6) return fail('الرمز يتكون من 6 أرقام.', 422, { field: 'code' });
          const err = checkCode(uid, 'signup', code); if (err) { await save(); return fail(err); }
          const u = byId(uid); if (!u) return fail('الحساب غير موجود.');
          u.status = 'active';
          await finishLogin(req, res, u);
          return ok({ user: pub(u) });
        }
        case 'resend': {
          if ((t = throttle(req, 'resend', 6, 3600))) return fail(t, 429);
          const u = flow.pending && byId(flow.pending);
          if (!u) return fail('انتهت الجلسة. سجّل الدخول مرة أخرى.');
          if (u.status !== 'pending') return fail('هذا الحساب مفعّل مسبقاً. سجّل الدخول.');
          if ((t = cooldown(u.id, 'signup'))) return fail(t, 429);
          const code = newCode(u.id, 'signup', CFG.SIGNUP_CODE_MINUTES); await save();
          if (!(await signupMail(u, code))) return fail('تعذّر الإرسال حالياً. حاول لاحقاً.', 502);
          return ok({});
        }
        case 'login': {
          if ((t = failBlocked(req, 'login', 40))) return fail(t, 429);
          const name = s('login'), u = byName(name) || byEmail(name);
          if (u && u.lockUntil && u.lockUntil > Date.now()) { logLogin(req, u, false, 'locked'); await save(); return fail(`تم إيقاف الدخول مؤقتاً بسبب محاولات خاطئة متكررة. حاول بعد ${Math.ceil((u.lockUntil - Date.now()) / 60000)} دقيقة.`, 423); }
          if (!u || !checkPass(String(b.password || ''), u.pass)) {
            if (u) { u.failCount = (u.failCount || 0) + 1; if (u.failCount >= CFG.LOCK_AFTER) { u.lockUntil = Date.now() + CFG.LOCK_MINUTES * 60000; u.failCount = 0; } }
            failHit(req, 'login'); logLogin(req, u, false, 'bad-password', name); await save();
            return fail('اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
          }
          if (u.status === 'pending') { writeFlow(req, res, { pending: u.id }, CFG.SIGNUP_CODE_MINUTES); return ok({ next: 'verify', email: u.email }); }
          if (u.status !== 'active') { logLogin(req, u, false, 'disabled'); await save(); return fail('هذا الحساب موقوف. تواصل مع مدير النظام.', 403); }
          if (u.mfa && u.mfa.enabled) { writeFlow(req, res, { mfa: u.id }, 5); return ok({ next: '2fa' }); }
          await finishLogin(req, res, u);
          return ok({ user: pub(u) });
        }
        case '2fa': {
          if ((t = failBlocked(req, '2fa', 20))) return fail(t, 429);
          const u = flow.mfa && byId(flow.mfa);
          if (!u || !u.mfa || !u.mfa.enabled) return fail('انتهت مهلة التحقق. سجّل الدخول من جديد.');
          const code = s('code').replace(/\s/g, '');
          let good = false;
          if (/^\d{6}$/.test(code)) { const st = totpCheck(decrypt(u.mfa.secret), code, u.mfa.lastStep || 0); if (st) { u.mfa.lastStep = st; good = true; } }
          else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code)) {
            const h = sha256(code.replace('-', '').toLowerCase()), i = (u.mfa.backup || []).indexOf(h);
            if (i >= 0) { u.mfa.backup.splice(i, 1); good = true; }
          }
          if (!good) {
            u.failCount = (u.failCount || 0) + 1; if (u.failCount >= CFG.LOCK_AFTER) { u.lockUntil = Date.now() + CFG.LOCK_MINUTES * 60000; u.failCount = 0; setCookies(res, [cookie(req, 'safa_flow', '', 0)]); }
            failHit(req, '2fa'); logLogin(req, u, false, 'bad-2fa'); await save();
            return fail('رمز التحقق غير صحيح.', 401, { field: 'code' });
          }
          await finishLogin(req, res, u);
          return ok({ user: pub(u), backupLeft: (u.mfa.backup || []).length });
        }
        case 'logout': {
          const cur = sessionOf(req); if (cur) { DB.sessions = DB.sessions.filter((x) => x.id !== cur.s.id); await save(); }
          setCookies(res, [cookie(req, 'safa_sid', '', 0), cookie(req, 'safa_flow', '', 0), cookie(req, 'safa_sess', '', 0)]);
          return ok({});
        }
        case 'forgot': {
          if ((t = throttle(req, 'forgot', 5, 3600))) return fail(t, 429);
          const email = s('email');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('أدخل بريداً إلكترونياً صحيحاً.', 422, { field: 'email' });
          const u = byEmail(email);
          if (u && u.status === 'active') {
            if ((t = cooldown(u.id, 'reset'))) return fail(t, 429);
            const code = newCode(u.id, 'reset', CFG.RESET_CODE_MINUTES); await save();
            await sendMail(u.email, `إعادة تعيين كلمة المرور - ${CFG.APP_NAME}`, mailWrap('إعادة تعيين كلمة المرور',
              `<p>مرحباً ${escH(u.username)}،</p><p>طلبت إعادة تعيين كلمة المرور. رمز التحقق:</p>${codeBox(code)}<p>الرمز صالح لمدة ${CFG.RESET_CODE_MINUTES} دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p>`));
          }
          writeFlow(req, res, { reset: email }, CFG.RESET_CODE_MINUTES);
          return ok({}); // same answer whether the email exists or not
        }
        case 'reset': {
          if ((t = throttle(req, 'reset', 15, 900))) return fail(t, 429);
          const code = s('code').replace(/\D/g, ''), pass = String(b.password || '');
          if (code.length !== 6) return fail('الرمز يتكون من 6 أرقام.', 422, { field: 'code' });
          const u = byEmail(flow.reset || s('email'));
          if (!u || u.status !== 'active') return fail('الرمز غير صحيح.');
          const pe = passwordError(pass, u.username); if (pe) return fail(pe, 422, { field: 'password' });
          const err = checkCode(u.id, 'reset', code); if (err) { await save(); return fail(err); }
          u.pass = hashPass(pass); revokeSessions(u.id);
          if (u.mfa && u.mfa.enabled) { await save(); writeFlow(req, res, { mfa: u.id }, 5); return ok({ next: '2fa' }); }
          await finishLogin(req, res, u);
          return ok({ user: pub(u) });
        }
        // ----- account security (signed-in user) -----
        case 'sessions': case 'session-revoke': case 'logout-all': case 'mfa-setup': case 'mfa-enable': case 'mfa-disable': {
          const cur = sessionOf(req); if (!cur) return fail('انتهت الجلسة. سجّل الدخول من جديد.', 401);
          const u = cur.u;
          if (action === 'sessions') return ok({ items: DB.sessions.filter((x) => x.uid === u.id).map((x) => ({ id: x.id, created: x.created, lastSeen: x.lastSeen, ip: x.ip, ua: x.ua, current: x.id === cur.s.id })).sort((a, b2) => b2.lastSeen - a.lastSeen),
            logins: DB.logins.filter((x) => x.uid === u.id).slice(-15).reverse(), mfa: !!(u.mfa && u.mfa.enabled), backupLeft: u.mfa && u.mfa.enabled ? (u.mfa.backup || []).length : 0 });
          if (action === 'session-revoke') { DB.sessions = DB.sessions.filter((x) => !(x.uid === u.id && x.id === +b.id && x.id !== cur.s.id)); await save(); return ok({}); }
          if (action === 'logout-all') { revokeSessions(u.id, cur.s.id); await save(); return ok({}); }
          if (action === 'mfa-setup') {
            if (u.mfa && u.mfa.enabled) return fail('التحقق بخطوتين مفعّل مسبقاً.');
            const secret = b32enc(crypto.randomBytes(20));
            u.mfaPending = encrypt(secret); await save();
            const uri = `otpauth://totp/${encodeURIComponent(CFG.APP_NAME)}:${encodeURIComponent(u.username)}?secret=${secret}&issuer=${encodeURIComponent(CFG.APP_NAME)}&algorithm=SHA1&digits=6&period=30`;
            const qr = await require('qrcode').toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
            return ok({ secret: secret.match(/.{1,4}/g).join(' '), qr });
          }
          if (action === 'mfa-enable') {
            if (!u.mfaPending) return fail('ابدأ الإعداد أولاً.');
            const secret = decrypt(u.mfaPending), st = totpCheck(secret, s('code').replace(/\s/g, ''));
            if (!st) return fail('الرمز غير صحيح. تأكد من ضبط وقت الهاتف تلقائياً ثم أعد المحاولة.', 422, { field: 'code' });
            const backup = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
            u.mfa = { enabled: true, secret: u.mfaPending, lastStep: st, backup: backup.map((c) => sha256(c)), enabledAt: Date.now() };
            delete u.mfaPending; revokeSessions(u.id, cur.s.id); await save();
            return ok({ backup: backup.map((c) => c.slice(0, 4) + '-' + c.slice(4)) });
          }
          if (action === 'mfa-disable') {
            if (!checkPass(String(b.password || ''), u.pass)) return fail('كلمة المرور غير صحيحة.', 422, { field: 'password' });
            u.mfa = null; delete u.mfaPending; await save();
            return ok({});
          }
          break;
        }
        default: return fail('Unknown action', 404);
      }
    } catch (e) {
      if (e.message === 'DBSAVE') return fail('تعذّر حفظ البيانات حالياً. حاول مرة أخرى بعد لحظات.', 503);
      console.error('[auth] error:', e);
      return fail('حدث خطأ في الخادم. حاول مرة أخرى.', 500);
    }
  });

  // ---------- ERP ----------
  await require('./erp')(app, {
    store,
    currentUser: (req) => { const c = sessionOf(req); if (c) req.sessionId = c.s.id; return c ? c.u : null; },
    users: () => DB.users,
    saveUsers: save,
    dataDir: CFG.DATA_DIR,
    adminEmail: CFG.ADMIN_EMAIL,
    hashPass, checkPass, passwordError, revokeSessions,
    createUser: (d) => {
      const u = { id: DB.nextId++, username: d.username, email: d.email, pass: hashPass(d.password), status: d.status || 'active', created: Date.now(),
        role: d.role, fullName: d.fullName || '', phone: d.phone || '', branchId: d.branchId || null, partyId: d.partyId || null };
      DB.users.push(u); return u;
    },
    loginLog: (uid) => DB.logins.filter((x) => x.uid === uid).slice(-50).reverse(),
  });

  // ---------- static files ----------
  app.use((req, res, next) => {
    const p = decodeURIComponent(req.path).toLowerCase();
    if (/^\/(data|api|node_modules|\.git|deploy|backups)(\/|$)/.test(p) || /^\/(server|erp|schema|store)\.js$/.test(p) ||
      /^\/(nodemon\.json|package(-lock)?\.json|yarn\.lock|dockerfile|docker-compose[\w.-]*\.ya?ml|caddyfile|\.env.*|\.gitignore|\.dockerignore)$/.test(p) || /\.(php|md|txt|sh|sql|bak|log)$/.test(p)) {
      return res.status(404).send('Not found');
    }
    next();
  });
  app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'deny', index: 'index.html',
    setHeaders: (res, fp) => { if (/\.(html|webmanifest)$|sw\.js$/.test(fp)) res.setHeader('Cache-Control', 'no-cache'); else if (/[\\/](fonts|icons|vendor)[\\/]/.test(fp)) res.setHeader('Cache-Control', 'public, max-age=604800'); } }));
  app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'index.html')); });
  app.use((err, req, res, next) => { console.error('[server] unhandled:', err); res.status(500).json({ ok: false, error: 'حدث خطأ في الخادم.' }); });

  const server = app.listen(CFG.PORT, () => {
    console.log(`${CFG.APP_NAME} v${VERSION} running on port ${CFG.PORT} (${CFG.NODE_ENV}, storage: ${store.kind})`);
    if (!transporter) console.log('⚠️  SMTP_PASS is not set: emails are written to data/mail.log instead of being sent.');
  });
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    console.log(`${sig} received, shutting down…`);
    server.close();
    setTimeout(() => process.exit(1), 10000).unref();
    try { await save(); if (global.__erpFlush) await global.__erpFlush(); await store.close(); } catch (e) { console.error(e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e));
start().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
