// Safa Shipping Console — Node.js server (for Bonto or any Node host)
// Serves the app from the repository root and provides the login API at /api/auth.php?action=...
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ================= settings (use Bonto environment variables) =================
const CFG = {
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'safabakr6.2@gmail.com',
  SITE_NAME: process.env.SITE_NAME || 'Safa Shipping Console',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: +(process.env.SMTP_PORT || 587),
  SMTP_USER: process.env.SMTP_USER || 'safabakr6.2@gmail.com',
  SMTP_PASS: (process.env.SMTP_PASS || '').replace(/\s+/g, ''), // Gmail App Password (16 letters)
  SIGNUP_CODE_MINUTES: 1440,
  RESET_CODE_MINUTES: 15,
};

// ================= storage (JSON file) =================
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.db');
fs.mkdirSync(DATA_DIR, { recursive: true });
let DB = { nextId: 1, users: [], codes: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (_) {}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB));
  fs.renameSync(tmp, DB_FILE);
}
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SECRET = process.env.SESSION_SECRET || (() => {
  try { return fs.readFileSync(SECRET_FILE, 'utf8'); } catch (_) {
    const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, s); return s;
  }
})();

// ================= crypto helpers =================
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(p, salt, 64).toString('hex')}`;
}
function checkPass(p, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(p, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const lc = (s) => String(s || '').trim().toLowerCase();
const byName = (n) => DB.users.find((u) => lc(u.username) === lc(n));
const byEmail = (e) => DB.users.find((u) => lc(u.email) === lc(e));
const byId = (id) => DB.users.find((u) => u.id === id);

// ================= session (signed cookie, survives app sleep) =================
function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('safa_sess='));
  if (!raw) return {};
  const [body, sig] = raw.slice(10).split('.');
  if (!body || !sig || hmac(body) !== sig) return {};
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    return s.exp > Date.now() ? s : {};
  } catch (_) { return {}; }
}
function writeSession(req, res, data) {
  const s = { ...data, exp: Date.now() + 30 * 864e5 };
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `safa_sess=${body}.${hmac(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
}

// ================= throttle (in memory) =================
const TH = new Map();
function throttle(req, action, max, windowSec) {
  const k = `${action}:${req.ip}`, now = Date.now(), r = TH.get(k);
  if (!r || now - r.since > windowSec * 1000) { TH.set(k, { n: 1, since: now }); return null; }
  if (r.n >= max) return 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.';
  r.n++; return null;
}

// ================= codes =================
function newCode(uid, purpose, minutes) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  DB.codes[`${uid}:${purpose}`] = { h: hmac(`${uid}:${purpose}:${code}`), exp: Date.now() + minutes * 60000, attempts: 0, sent: Date.now() };
  save();
  return code;
}
function checkCode(uid, purpose, code) {
  const k = `${uid}:${purpose}`, c = DB.codes[k];
  if (!c) return 'لا يوجد رمز فعّال. اطلب رمزاً جديداً.';
  if (c.exp < Date.now()) return 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.';
  if (c.attempts >= 5) return 'تجاوزت عدد المحاولات المسموح. اطلب رمزاً جديداً.';
  if (c.h !== hmac(`${uid}:${purpose}:${code}`)) {
    c.attempts++; save();
    const left = 5 - c.attempts;
    return left > 0 ? `الرمز غير صحيح. بقي لك ${left} محاولات.` : 'الرمز غير صحيح. اطلب رمزاً جديداً.';
  }
  delete DB.codes[k]; save();
  return null;
}
function cooldown(uid, purpose, sec = 60) {
  const c = DB.codes[`${uid}:${purpose}`];
  if (c && Date.now() - c.sent < sec * 1000) return `انتظر ${Math.ceil(sec - (Date.now() - c.sent) / 1000)} ثانية قبل طلب رمز جديد.`;
  return null;
}

// ================= mail =================
const transporter = CFG.SMTP_PASS ? nodemailer.createTransport({
  host: CFG.SMTP_HOST, port: CFG.SMTP_PORT, secure: CFG.SMTP_PORT === 465,
  auth: { user: CFG.SMTP_USER, pass: CFG.SMTP_PASS },
}) : null;
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = (title, body) => `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#E6EDF2;padding:24px">
  <div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D6E0E7">
  <div style="background:#0E2A3B;color:#fff;padding:18px 22px;font-size:17px;font-weight:bold">⚓ ${escH(CFG.SITE_NAME)}</div>
  <div style="padding:22px;color:#14232E;font-size:15px;line-height:1.8"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}</div></div></div>`;
const codeBox = (c) => `<div style="font-size:30px;letter-spacing:8px;font-weight:bold;text-align:center;background:#FBF1D6;border-radius:10px;padding:14px;margin:16px 0;direction:ltr">${c}</div>`;
async function sendMail(to, subject, html) {
  if (!transporter) {
    const text = html.replace(/<br>|<\/p>|<\/div>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n\s*\n+/g, '\n');
    const entry = `=== ${new Date().toISOString()} TO: ${to} | ${subject}\n${text}\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'mail.log'), entry);
    console.log('[mail — SMTP_PASS not set, email not sent]\n' + entry);
    return true;
  }
  try {
    await transporter.sendMail({ from: `"${CFG.SITE_NAME}" <${CFG.SMTP_USER}>`, to, subject, html });
    return true;
  } catch (e) { console.error('Mail error:', e.message); return false; }
}
function signupMail(u, code) {
  const mailto = `mailto:${encodeURIComponent(u.email)}?subject=${encodeURIComponent('رمز تفعيل حسابك - ' + CFG.SITE_NAME)}&body=${encodeURIComponent(`مرحباً ${u.username}،\n\nرمز تفعيل حسابك في ${CFG.SITE_NAME} هو: ${code}\n\nأدخله في صفحة التفعيل لإكمال التسجيل.`)}`;
  const body = `<p>وصل طلب تسجيل جديد:</p>
    <p><b>اسم المستخدم:</b> ${escH(u.username)}<br><b>البريد:</b> <span dir="ltr">${escH(u.email)}</span></p>
    <p>رمز التفعيل:</p>${codeBox(code)}
    <p>إذا وافقت على الطلب، أرسل هذا الرمز إلى بريد المستخدم. الرمز صالح لمدة ${CFG.SIGNUP_CODE_MINUTES / 60} ساعة.</p>
    <p style="text-align:center"><a href="${escH(mailto)}" style="display:inline-block;background:#0E2A3B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px">إرسال الرمز إلى المستخدم</a></p>
    <p style="color:#5E7282;font-size:13px">إذا لم توافق، تجاهل هذه الرسالة ولن يتمكن من الدخول.</p>`;
  return sendMail(CFG.ADMIN_EMAIL, `طلب تسجيل جديد: ${u.username}`, wrap('طلب تسجيل جديد', body));
}

// ================= app =================
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

const pub = (u) => ({ username: u.username, email: u.email });
function loginUser(req, res, u) { u.lastLogin = Date.now(); save(); writeSession(req, res, { uid: u.id }); }

// same path as the PHP version so the frontend works unchanged on both
app.all(['/api/auth.php', '/api/auth'], async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ok = (d) => res.json({ ok: true, ...d });
  const fail = (error, code = 400, extra = {}) => res.status(code).json({ ok: false, error, ...extra });
  const action = req.query.action || '';
  const b = req.body || {};
  const s = (k) => String(b[k] ?? '').trim();
  const sess = readSession(req);
  if (action !== 'me' && req.method !== 'POST') return fail('Method not allowed', 405);
  let t;

  try {
    switch (action) {
      case 'me': {
        const u = sess.uid && byId(sess.uid);
        return u && u.status === 'active' ? ok({ user: pub(u) }) : res.json({ ok: false, user: null });
      }
      case 'register': {
        if ((t = throttle(req, 'register', 5, 3600))) return fail(t, 429);
        const username = s('username'), email = s('email'), pass = String(b.password || '');
        if (!/^[\p{L}\p{N}_.]{3,30}$/u.test(username)) return fail('اسم المستخدم يجب أن يكون من 3 إلى 30 حرفاً أو رقماً بدون مسافات.', 422, { field: 'username' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('أدخل بريداً إلكترونياً صحيحاً.', 422, { field: 'email' });
        if (pass.length < 8) return fail('كلمة المرور يجب أن تكون 8 أحرف على الأقل.', 422, { field: 'password' });
        const exU = byName(username), exE = byEmail(email);
        if (exU && exU.status === 'active') return fail('اسم المستخدم مستخدم مسبقاً.', 409, { field: 'username' });
        if (exE && exE.status === 'active') return fail('هذا البريد مسجّل مسبقاً. سجّل الدخول أو أعد تعيين كلمة المرور.', 409, { field: 'email' });
        for (const old of [exU, exE]) if (old && old.status === 'pending') {
          DB.users = DB.users.filter((x) => x.id !== old.id);
          delete DB.codes[`${old.id}:signup`];
        }
        const u = { id: DB.nextId++, username, email, pass: hashPass(pass), status: 'pending', created: Date.now() };
        DB.users.push(u); save();
        const code = newCode(u.id, 'signup', CFG.SIGNUP_CODE_MINUTES);
        if (!(await signupMail(u, code))) return fail('تعذّر إرسال الطلب حالياً. حاول مرة أخرى بعد قليل.', 502);
        writeSession(req, res, { pending: u.id });
        return ok({ next: 'verify', email: u.email });
      }
      case 'verify': {
        if ((t = throttle(req, 'verify', 20, 900))) return fail(t, 429);
        const uid = sess.pending;
        if (!uid) return fail('انتهت الجلسة. سجّل الدخول باسم المستخدم وكلمة المرور ثم أدخل الرمز.');
        const code = s('code').replace(/\D/g, '');
        if (code.length !== 6) return fail('الرمز يتكون من 6 أرقام.', 422, { field: 'code' });
        const err = checkCode(uid, 'signup', code); if (err) return fail(err);
        const u = byId(uid); if (!u) return fail('الحساب غير موجود.');
        u.status = 'active'; save();
        loginUser(req, res, u);
        return ok({ user: pub(u) });
      }
      case 'resend': {
        if ((t = throttle(req, 'resend', 6, 3600))) return fail(t, 429);
        const u = sess.pending && byId(sess.pending);
        if (!u) return fail('انتهت الجلسة. سجّل الدخول مرة أخرى.');
        if (u.status !== 'pending') return fail('هذا الحساب مفعّل مسبقاً. سجّل الدخول.');
        if ((t = cooldown(u.id, 'signup'))) return fail(t, 429);
        const code = newCode(u.id, 'signup', CFG.SIGNUP_CODE_MINUTES);
        if (!(await signupMail(u, code))) return fail('تعذّر الإرسال حالياً. حاول لاحقاً.', 502);
        return ok({});
      }
      case 'login': {
        if ((t = throttle(req, 'login', 10, 900))) return fail(t, 429);
        const u = byName(s('login')) || byEmail(s('login'));
        if (!u || !checkPass(String(b.password || ''), u.pass)) return fail('اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
        if (u.status === 'pending') { writeSession(req, res, { pending: u.id }); return ok({ next: 'verify', email: u.email }); }
        loginUser(req, res, u);
        return ok({ user: pub(u) });
      }
      case 'logout':
        res.setHeader('Set-Cookie', 'safa_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        return ok({});
      case 'forgot': {
        if ((t = throttle(req, 'forgot', 5, 3600))) return fail(t, 429);
        const email = s('email');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('أدخل بريداً إلكترونياً صحيحاً.', 422, { field: 'email' });
        const u = byEmail(email);
        if (u && u.status === 'active') {
          if ((t = cooldown(u.id, 'reset'))) return fail(t, 429);
          const code = newCode(u.id, 'reset', CFG.RESET_CODE_MINUTES);
          await sendMail(u.email, `إعادة تعيين كلمة المرور - ${CFG.SITE_NAME}`, wrap('إعادة تعيين كلمة المرور',
            `<p>مرحباً ${escH(u.username)}،</p><p>طلبت إعادة تعيين كلمة المرور. رمز التحقق:</p>${codeBox(code)}<p>الرمز صالح لمدة ${CFG.RESET_CODE_MINUTES} دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p>`));
        }
        writeSession(req, res, { reset: email });
        return ok({}); // same answer whether the email exists or not
      }
      case 'reset': {
        if ((t = throttle(req, 'reset', 15, 900))) return fail(t, 429);
        const code = s('code').replace(/\D/g, ''), pass = String(b.password || '');
        if (code.length !== 6) return fail('الرمز يتكون من 6 أرقام.', 422, { field: 'code' });
        if (pass.length < 8) return fail('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.', 422, { field: 'password' });
        const u = byEmail(sess.reset || s('email'));
        if (!u || u.status !== 'active') return fail('الرمز غير صحيح.');
        const err = checkCode(u.id, 'reset', code); if (err) return fail(err);
        u.pass = hashPass(pass); save();
        loginUser(req, res, u);
        return ok({ user: pub(u) });
      }
      default: return fail('Unknown action', 404);
    }
  } catch (e) {
    console.error('Auth error:', e);
    return fail('حدث خطأ في الخادم. حاول مرة أخرى.', 500);
  }
});

// The app files sit in the repository root next to this server.
// Block anything that must never be downloaded (user database, server code, PHP version, git data).
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path).toLowerCase();
  if (/^\/(data|api|node_modules|\.git)(\/|$)/.test(p) || /^\/(server\.js|package(-lock)?\.json|\.env|\.gitignore)$/.test(p) || /\.(php|md|txt)$/.test(p)) {
    return res.status(404).send('Not found');
  }
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'deny', index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Safa Shipping Console running on port ${port}`);
  if (!transporter) console.log('⚠️  SMTP_PASS is not set: emails are printed here in the console instead of being sent.');
});
