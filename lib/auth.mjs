import crypto from 'crypto';

const COOKIE_NAME = 'coread_session';
const MAX_LOGIN_BYTES = 4096;

export function getAccessToken() {
  return String(process.env.COREAD_ACCESS_TOKEN || '').trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(req) {
  const result = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { /* ignore malformed cookies */ }
  }
  return result;
}

export function isAuthorized(req) {
  const expected = getAccessToken();
  if (!expected) return true;
  const authorization = String(req.headers?.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const headerToken = String(req.headers?.['x-coread-token'] || '');
  const cookieToken = cookies(req)[COOKIE_NAME] || '';
  return [bearer, headerToken, cookieToken].some(candidate => safeEqual(candidate, expected));
}

function isSecureRequest(req) {
  if (process.env.COREAD_COOKIE_SECURE === '0') return false;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto ? proto === 'https' : process.env.NODE_ENV === 'production';
}

function sessionCookie(req, value, maxAge) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_LOGIN_BYTES) reject(Object.assign(new Error('Login form too large'), { status: 413 }));
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function loginPage(error = '') {
  const message = error ? '<p class="error">钥匙不对，再试一次。</p>' : '<p>输入 Zeabur 中设置的访问钥匙。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共读室 · 登录</title><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,#eadff1 0,transparent 38%),#f7f2f5;color:#302832;font:15px/1.7 system-ui,-apple-system,sans-serif}.card{width:min(100%,390px);padding:34px 28px;border:1px solid #d8cbd5;border-radius:26px;background:#fffafccc;box-shadow:0 24px 80px #60445a1f;backdrop-filter:blur(18px)}h1{margin:0 0 8px;font:600 29px/1.2 ui-serif,serif;letter-spacing:.08em}p{margin:0 0 22px;color:#796d77}.error{color:#a33b53}label{display:block;margin-bottom:8px;font-weight:600}input{width:100%;padding:13px 14px;border:1px solid #cfc0cb;border-radius:13px;background:#fff;color:#302832;font:inherit;outline:none}input:focus{border-color:#8b647d;box-shadow:0 0 0 3px #8b647d1f}button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:13px;background:#60445a;color:white;font:600 15px system-ui;cursor:pointer}.mark{font-size:12px;letter-spacing:.22em;color:#a58f9f;margin-bottom:18px}@media(prefers-color-scheme:dark){body{background:radial-gradient(circle at 20% 10%,#392c3a 0,transparent 40%),#171316;color:#f5edf3}.card{background:#211b20dd;border-color:#4a3d47}.card p{color:#b9aab5}input{background:#171316;color:#f5edf3;border-color:#594955}button{background:#b58ba7;color:#1d171b}}
  </style></head><body><main class="card"><div class="mark">COREAD</div><h1>回到共读室</h1>${message}<form method="post" action="/auth/login"><label for="token">访问钥匙</label><input id="token" name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">开门</button></form></main></body></html>`;
}

export async function handleAuthRoute(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage(url.searchParams.get('error') === '1'));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    try {
      const form = await readForm(req);
      const token = String(form.get('token') || '');
      if (!getAccessToken() || !safeEqual(token, getAccessToken())) {
        res.writeHead(303, { Location: '/login?error=1', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': sessionCookie(req, token, 60 * 60 * 24 * 30),
        'Cache-Control': 'no-store',
      });
      res.end();
    } catch (error) {
      res.writeHead(error.status || 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': sessionCookie(req, '', 0),
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }
  return false;
}

export function rejectUnauthorized(req, res, url) {
  if (isAuthorized(req)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-coread-token, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
    });
    res.end();
    return true;
  }
  const apiLike = url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/messages' || url.pathname.startsWith('/v1/');
  if (apiLike) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Bearer realm="coread"',
    });
    res.end(JSON.stringify({ error: 'unauthorized', message: 'Valid COREAD_ACCESS_TOKEN required' }));
  } else {
    res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
  }
  return true;
}
