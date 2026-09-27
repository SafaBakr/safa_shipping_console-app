<?php
declare(strict_types=1);
if (!function_exists('mb_strlen')) { function mb_strlen(string $s): int { return strlen(utf8_decode($s)); } }
require __DIR__ . '/config.php';
require __DIR__ . '/lib/Exception.php';
require __DIR__ . '/lib/PHPMailer.php';
require __DIR__ . '/lib/SMTP.php';

use PHPMailer\PHPMailer\PHPMailer;

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

session_name('safa_sess');
session_set_cookie_params([
  'lifetime' => 60 * 60 * 24 * 30,
  'path' => '/',
  'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
  'httponly' => true,
  'samesite' => 'Lax',
]);
session_start();

function out(array $data, int $code = 200): void {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}
function fail(string $msg, int $code = 400, array $extra = []): void { out(['ok' => false, 'error' => $msg] + $extra, $code); }

// ---------------- database ----------------
function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $dir = __DIR__ . '/data';
  if (!is_dir($dir)) mkdir($dir, 0750, true);
  $pdo = new PDO('sqlite:' . $dir . '/users.sqlite');
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
  $pdo->exec('PRAGMA journal_mode = WAL');
  $pdo->exec('CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT "pending",
    created_at INTEGER NOT NULL,
    last_login INTEGER
  )');
  $pdo->exec('CREATE TABLE IF NOT EXISTS codes (
    user_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, purpose)
  )');
  $pdo->exec('CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, since INTEGER NOT NULL)');
  return $pdo;
}

// simple per-IP throttle: max $max actions per $window seconds
function throttle(string $action, int $max, int $window): void {
  $k = $action . ':' . ($_SERVER['REMOTE_ADDR'] ?? '0');
  $now = time();
  $row = db()->prepare('SELECT n, since FROM throttle WHERE k = ?');
  $row->execute([$k]);
  $r = $row->fetch();
  if (!$r || $now - (int)$r['since'] > $window) {
    db()->prepare('REPLACE INTO throttle (k, n, since) VALUES (?, 1, ?)')->execute([$k, $now]);
    return;
  }
  if ((int)$r['n'] >= $max) fail('محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.', 429);
  db()->prepare('UPDATE throttle SET n = n + 1 WHERE k = ?')->execute([$k]);
}

// ---------------- mail ----------------
function send_mail(string $to, string $subject, string $html): bool {
  if (SMTP_PASS === '') {
    file_put_contents(__DIR__ . '/data/mail.log',
      "=== " . date('c') . " TO: $to | $subject\n" . strip_tags(str_replace(['<br>', '</p>', '</div>'], "\n", $html)) . "\n\n", FILE_APPEND);
    return true;
  }
  $m = new PHPMailer(true);
  try {
    $m->isSMTP();
    $m->Host = SMTP_HOST;
    $m->SMTPAuth = true;
    $m->Username = SMTP_USER;
    $m->Password = SMTP_PASS;
    $m->SMTPSecure = SMTP_PORT == 465 ? PHPMailer::ENCRYPTION_SMTPS : PHPMailer::ENCRYPTION_STARTTLS;
    $m->Port = SMTP_PORT;
    $m->CharSet = 'UTF-8';
    $m->setFrom(SMTP_USER, SMTP_FROM_NAME);
    $m->addAddress($to);
    $m->isHTML(true);
    $m->Subject = $subject;
    $m->Body = $html;
    $m->AltBody = strip_tags(str_replace(['<br>', '</p>'], "\n", $html));
    $m->send();
    return true;
  } catch (Throwable $e) {
    error_log('Mail error: ' . $e->getMessage());
    return false;
  }
}
function mail_wrap(string $title, string $body): string {
  $site = htmlspecialchars(SITE_NAME);
  return '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#E6EDF2;padding:24px">
    <div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D6E0E7">
      <div style="background:#0E2A3B;color:#fff;padding:18px 22px;font-size:17px;font-weight:bold">⚓ ' . $site . '</div>
      <div style="padding:22px;color:#14232E;font-size:15px;line-height:1.8"><h2 style="margin:0 0 12px;font-size:18px">' . $title . '</h2>' . $body . '</div>
    </div></div>';
}
function code_box(string $code): string {
  return '<div style="font-size:30px;letter-spacing:8px;font-weight:bold;text-align:center;background:#FBF1D6;border-radius:10px;padding:14px;margin:16px 0;direction:ltr">' . $code . '</div>';
}

// ---------------- codes ----------------
function new_code(int $uid, string $purpose, int $minutes): string {
  $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
  db()->prepare('REPLACE INTO codes (user_id, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)')
      ->execute([$uid, $purpose, password_hash($code, PASSWORD_DEFAULT), time() + $minutes * 60, time()]);
  return $code;
}
function check_code(int $uid, string $purpose, string $code): void {
  $st = db()->prepare('SELECT * FROM codes WHERE user_id = ? AND purpose = ?');
  $st->execute([$uid, $purpose]);
  $c = $st->fetch();
  if (!$c) fail('لا يوجد رمز فعّال. اطلب رمزاً جديداً.');
  if ((int)$c['expires_at'] < time()) fail('انتهت صلاحية الرمز. اطلب رمزاً جديداً.');
  if ((int)$c['attempts'] >= 5) fail('تجاوزت عدد المحاولات المسموح. اطلب رمزاً جديداً.');
  if (!password_verify($code, $c['code_hash'])) {
    db()->prepare('UPDATE codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?')->execute([$uid, $purpose]);
    $left = 4 - (int)$c['attempts'];
    fail($left > 0 ? "الرمز غير صحيح. بقي لك $left محاولات." : 'الرمز غير صحيح. اطلب رمزاً جديداً.');
  }
  db()->prepare('DELETE FROM codes WHERE user_id = ? AND purpose = ?')->execute([$uid, $purpose]);
}
function cooldown(int $uid, string $purpose, int $sec = 60): void {
  $st = db()->prepare('SELECT sent_at FROM codes WHERE user_id = ? AND purpose = ?');
  $st->execute([$uid, $purpose]);
  $t = $st->fetchColumn();
  if ($t && time() - (int)$t < $sec) fail('انتظر ' . ($sec - (time() - (int)$t)) . ' ثانية قبل طلب رمز جديد.', 429);
}

function send_signup_to_admin(array $u, string $code): bool {
  $user = htmlspecialchars($u['username']); $email = htmlspecialchars($u['email']);
  $mailto = 'mailto:' . rawurlencode($u['email']) . '?subject=' . rawurlencode('رمز تفعيل حسابك - ' . SITE_NAME)
          . '&body=' . rawurlencode("مرحباً {$u['username']}،\n\nرمز تفعيل حسابك في " . SITE_NAME . " هو: $code\n\nأدخله في صفحة التفعيل لإكمال التسجيل.");
  $body = '<p>وصل طلب تسجيل جديد:</p>
    <p><b>اسم المستخدم:</b> ' . $user . '<br><b>البريد:</b> <span dir="ltr">' . $email . '</span></p>
    <p>رمز التفعيل:</p>' . code_box($code) . '
    <p>إذا وافقت على الطلب، أرسل هذا الرمز إلى بريد المستخدم. الرمز صالح لمدة ' . intdiv(SIGNUP_CODE_MINUTES, 60) . ' ساعة.</p>
    <p style="text-align:center"><a href="' . htmlspecialchars($mailto) . '" style="display:inline-block;background:#0E2A3B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px">إرسال الرمز إلى المستخدم</a></p>
    <p style="color:#5E7282;font-size:13px">إذا لم توافق، تجاهل هذه الرسالة ولن يتمكن من الدخول.</p>';
  return send_mail(ADMIN_EMAIL, 'طلب تسجيل جديد: ' . $u['username'], mail_wrap('طلب تسجيل جديد', $body));
}

function user_by(string $field, string $v): ?array {
  $st = db()->prepare("SELECT * FROM users WHERE $field = ? COLLATE NOCASE");
  $st->execute([$v]);
  return $st->fetch() ?: null;
}
function login_user(array $u): void {
  session_regenerate_id(true);
  $_SESSION['uid'] = (int)$u['id'];
  $_SESSION['username'] = $u['username'];
  db()->prepare('UPDATE users SET last_login = ? WHERE id = ?')->execute([time(), $u['id']]);
}

// ---------------- router ----------------
$action = $_GET['action'] ?? '';
$in = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
$s = fn(string $k) => trim((string)($in[$k] ?? ''));

if ($action !== 'me' && $_SERVER['REQUEST_METHOD'] !== 'POST') fail('Method not allowed', 405);

try {
  switch ($action) {

    case 'me':
      if (!empty($_SESSION['uid'])) {
        $u = user_by('id', (string)$_SESSION['uid']);
        if ($u && $u['status'] === 'active') out(['ok' => true, 'user' => ['username' => $u['username'], 'email' => $u['email']]]);
        session_destroy();
      }
      out(['ok' => false, 'user' => null]);

    case 'register':
      throttle('register', 5, 3600);
      $username = $s('username'); $email = $s('email'); $pass = (string)($in['password'] ?? '');
      if (!preg_match('/^[\p{L}\p{N}_.]{3,30}$/u', $username)) fail('اسم المستخدم يجب أن يكون من 3 إلى 30 حرفاً أو رقماً بدون مسافات.', 422, ['field' => 'username']);
      if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('أدخل بريداً إلكترونياً صحيحاً.', 422, ['field' => 'email']);
      if (mb_strlen($pass) < 8) fail('كلمة المرور يجب أن تكون 8 أحرف على الأقل.', 422, ['field' => 'password']);
      $exU = user_by('username', $username); $exE = user_by('email', $email);
      if (($exU && $exU['status'] === 'active')) fail('اسم المستخدم مستخدم مسبقاً.', 409, ['field' => 'username']);
      if (($exE && $exE['status'] === 'active')) fail('هذا البريد مسجّل مسبقاً. سجّل الدخول أو أعد تعيين كلمة المرور.', 409, ['field' => 'email']);
      // remove stale pending records that collide
      foreach ([$exU, $exE] as $old) if ($old && $old['status'] === 'pending') {
        db()->prepare('DELETE FROM codes WHERE user_id = ?')->execute([$old['id']]);
        db()->prepare('DELETE FROM users WHERE id = ?')->execute([$old['id']]);
      }
      db()->prepare('INSERT INTO users (username, email, pass_hash, status, created_at) VALUES (?, ?, ?, "pending", ?)')
          ->execute([$username, $email, password_hash($pass, PASSWORD_DEFAULT), time()]);
      $u = user_by('username', $username);
      $code = new_code((int)$u['id'], 'signup', SIGNUP_CODE_MINUTES);
      if (!send_signup_to_admin($u, $code)) fail('تعذّر إرسال الطلب حالياً. حاول مرة أخرى بعد قليل.', 502);
      $_SESSION['pending'] = (int)$u['id'];
      out(['ok' => true, 'next' => 'verify', 'email' => $u['email']]);

    case 'verify':
      throttle('verify', 20, 900);
      $uid = (int)($_SESSION['pending'] ?? 0);
      if (!$uid && $s('login') !== '') { $u = user_by('username', $s('login')) ?? user_by('email', $s('login')); $uid = $u ? (int)$u['id'] : 0; }
      if (!$uid) fail('انتهت الجلسة. سجّل الدخول باسم المستخدم وكلمة المرور ثم أدخل الرمز.');
      $code = preg_replace('/\D/', '', $s('code'));
      if (strlen($code) !== 6) fail('الرمز يتكون من 6 أرقام.', 422, ['field' => 'code']);
      check_code($uid, 'signup', $code);
      db()->prepare('UPDATE users SET status = "active" WHERE id = ?')->execute([$uid]);
      unset($_SESSION['pending']);
      $u = user_by('id', (string)$uid);
      login_user($u);
      out(['ok' => true, 'user' => ['username' => $u['username'], 'email' => $u['email']]]);

    case 'resend':
      throttle('resend', 6, 3600);
      $uid = (int)($_SESSION['pending'] ?? 0);
      if (!$uid) fail('انتهت الجلسة. سجّل الدخول مرة أخرى.');
      cooldown($uid, 'signup');
      $u = user_by('id', (string)$uid);
      if (!$u || $u['status'] !== 'pending') fail('هذا الحساب مفعّل مسبقاً. سجّل الدخول.');
      $code = new_code($uid, 'signup', SIGNUP_CODE_MINUTES);
      if (!send_signup_to_admin($u, $code)) fail('تعذّر الإرسال حالياً. حاول لاحقاً.', 502);
      out(['ok' => true]);

    case 'login':
      throttle('login', 10, 900);
      $login = $s('login'); $pass = (string)($in['password'] ?? '');
      $u = user_by('username', $login) ?? user_by('email', $login);
      if (!$u || !password_verify($pass, $u['pass_hash'])) fail('اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
      if ($u['status'] === 'pending') { $_SESSION['pending'] = (int)$u['id']; out(['ok' => true, 'next' => 'verify', 'email' => $u['email']]); }
      if ($u['status'] !== 'active') fail('هذا الحساب غير مفعّل.', 403);
      login_user($u);
      out(['ok' => true, 'user' => ['username' => $u['username'], 'email' => $u['email']]]);

    case 'logout':
      $_SESSION = [];
      session_destroy();
      out(['ok' => true]);

    case 'forgot':
      throttle('forgot', 5, 3600);
      $email = $s('email');
      if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('أدخل بريداً إلكترونياً صحيحاً.', 422, ['field' => 'email']);
      $u = user_by('email', $email);
      if ($u && $u['status'] === 'active') {
        cooldown((int)$u['id'], 'reset');
        $code = new_code((int)$u['id'], 'reset', RESET_CODE_MINUTES);
        $body = '<p>مرحباً ' . htmlspecialchars($u['username']) . '،</p><p>طلبت إعادة تعيين كلمة المرور. رمز التحقق:</p>' . code_box($code)
              . '<p>الرمز صالح لمدة ' . RESET_CODE_MINUTES . ' دقيقة. إذا لم تطلب ذلك، تجاهل هذه الرسالة وكلمة مرورك لن تتغير.</p>';
        send_mail($u['email'], 'إعادة تعيين كلمة المرور - ' . SITE_NAME, mail_wrap('إعادة تعيين كلمة المرور', $body));
      }
      $_SESSION['reset_email'] = $email;
      out(['ok' => true]); // same response whether the email exists or not

    case 'reset':
      throttle('reset', 15, 900);
      $email = (string)($_SESSION['reset_email'] ?? $s('email'));
      $code = preg_replace('/\D/', '', $s('code')); $pass = (string)($in['password'] ?? '');
      if (strlen($code) !== 6) fail('الرمز يتكون من 6 أرقام.', 422, ['field' => 'code']);
      if (mb_strlen($pass) < 8) fail('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.', 422, ['field' => 'password']);
      $u = $email ? user_by('email', $email) : null;
      if (!$u || $u['status'] !== 'active') fail('الرمز غير صحيح.');
      check_code((int)$u['id'], 'reset', $code);
      db()->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
      unset($_SESSION['reset_email']);
      login_user($u);
      out(['ok' => true, 'user' => ['username' => $u['username'], 'email' => $u['email']]]);

    default:
      fail('Unknown action', 404);
  }
} catch (Throwable $e) {
  error_log('Auth error: ' . $e->getMessage());
  fail('حدث خطأ في الخادم. حاول مرة أخرى.', 500);
}
