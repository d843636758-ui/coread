import crypto from 'crypto';

const MAX_BODY_BYTES = 32 * 1024;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const authorizationCodes = new Map();
const failedLogins = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createEnvelope(kind, payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${kind}.${encoded}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

function readEnvelope(value, kind, secret) {
  const [actualKind, encoded, signature, ...rest] = String(value || '').split('.');
  if (rest.length || actualKind !== kind || !encoded || !signature) return null;
  const unsigned = `${actualKind}.${encoded}`;
  if (!safeEqual(signature, sign(unsigned, secret))) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { return null; }
}

function configuredOrigin() {
  const value = String(process.env.COREAD_PUBLIC_URL || '').trim();
  if (!value) return '';
  try { return new URL(value).origin; } catch { return ''; }
}

export function requestOrigin(req) {
  const configured = configuredOrigin();
  if (configured) return configured;
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function oauthResource(req) {
  return `${requestOrigin(req)}/mcp`;
}

export function oauthResourceMetadataUrl(req) {
  return `${requestOrigin(req)}/.well-known/oauth-protected-resource`;
}

export function verifyOAuthAccessToken(token, secret) {
  if (!secret) return false;
  const payload = readEnvelope(token, 'coread_at', secret);
  if (!payload || payload.sub !== 'coread-owner' || payload.scope !== 'coread') return false;
  const now = Math.floor(Date.now() / 1000);
  return Number.isFinite(payload.exp) && payload.exp > now && Number.isFinite(payload.iat) && payload.iat <= now + 60;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) reject(Object.assign(new Error('Request too large'), { status: 413 }));
      else chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseClient(clientId, secret) {
  const client = readEnvelope(clientId, 'coread_client', secret);
  if (!client || !Array.isArray(client.redirect_uris)) return null;
  return client;
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  } catch { return false; }
}

function validateAuthorization(params, req, secret) {
  const responseType = String(params.get('response_type') || '');
  const clientId = String(params.get('client_id') || '');
  const redirectUri = String(params.get('redirect_uri') || '');
  const codeChallenge = String(params.get('code_challenge') || '');
  const codeChallengeMethod = String(params.get('code_challenge_method') || '');
  const resource = String(params.get('resource') || oauthResource(req));
  const scope = String(params.get('scope') || 'coread');
  const client = parseClient(clientId, secret);
  if (responseType !== 'code') throw new Error('Only response_type=code is supported');
  if (!client || !client.redirect_uris.includes(redirectUri)) throw new Error('Unknown client or redirect URI');
  if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new Error('PKCE S256 is required');
  if (resource !== oauthResource(req)) throw new Error('Invalid OAuth resource');
  if (!scope.split(/\s+/).includes('coread')) throw new Error('The coread scope is required');
  return { clientId, redirectUri, codeChallenge, resource, scope: 'coread' };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function authorizationPage(params, error = '') {
  const fields = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'scope']
    .map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) || '')}">`).join('');
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '<p>ChatGPT 正在请求连接你的共读室。输入 Zeabur 中的访问钥匙以授权。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共读室 · 授权 ChatGPT</title><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,#eadff1 0,transparent 38%),#f7f2f5;color:#302832;font:15px/1.7 system-ui,-apple-system,sans-serif}.card{width:min(100%,410px);padding:34px 28px;border:1px solid #d8cbd5;border-radius:26px;background:#fffafccc;box-shadow:0 24px 80px #60445a1f;backdrop-filter:blur(18px)}h1{margin:0 0 8px;font:600 27px/1.25 ui-serif,serif;letter-spacing:.04em}p{margin:0 0 22px;color:#796d77}.error{color:#a33b53}label{display:block;margin-bottom:8px;font-weight:600}input[type=password]{width:100%;padding:13px 14px;border:1px solid #cfc0cb;border-radius:13px;background:#fff;color:#302832;font:inherit;outline:none}input:focus{border-color:#8b647d;box-shadow:0 0 0 3px #8b647d1f}button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:13px;background:#60445a;color:white;font:600 15px system-ui;cursor:pointer}.mark{font-size:12px;letter-spacing:.22em;color:#a58f9f;margin-bottom:18px}.scope{margin:18px 0;padding:12px 14px;border-radius:12px;background:#60445a0d;color:#60445a;font-size:13px}@media(prefers-color-scheme:dark){body{background:radial-gradient(circle at 20% 10%,#392c3a 0,transparent 40%),#171316;color:#f5edf3}.card{background:#211b20dd;border-color:#4a3d47}.card p{color:#b9aab5}input[type=password]{background:#171316;color:#f5edf3;border-color:#594955}button{background:#b58ba7;color:#1d171b}.scope{color:#d7b9cc;background:#ffffff0a}}
  </style></head><body><main class="card"><div class="mark">COREAD × CHATGPT</div><h1>授权进入共读室</h1>${message}<div class="scope">允许 ChatGPT 查看书架、阅读内容并使用共读批注工具。</div><form method="post" action="/oauth/authorize">${fields}<label for="token">访问钥匙</label><input id="token" name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">确认授权</button></form></main></body></html>`;
}

function loginKey(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function loginBlocked(req) {
  const record = failedLogins.get(loginKey(req));
  if (!record || record.resetAt <= Date.now()) return false;
  return record.count >= 8;
}

function recordFailedLogin(req) {
  const key = loginKey(req);
  const current = failedLogins.get(key);
  const now = Date.now();
  failedLogins.set(key, !current || current.resetAt <= now ? { count: 1, resetAt: now + 10 * 60 * 1000 } : { ...current, count: current.count + 1 });
}

function clearFailedLogins(req) {
  failedLogins.delete(loginKey(req));
}

function cleanupCodes() {
  const now = Date.now();
  for (const [code, value] of authorizationCodes) if (value.expiresAt <= now) authorizationCodes.delete(code);
}

export async function handleOAuthRoute(req, res, url, secret) {
  const origin = requestOrigin(req);
  const resource = oauthResource(req);

  if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
    json(res, 200, { resource, authorization_servers: [origin], scopes_supported: ['coread'], resource_documentation: `${origin}/` });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['coread'],
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/oauth/register') {
    if (!secret) { json(res, 503, { error: 'temporarily_unavailable', error_description: 'COREAD_ACCESS_TOKEN is not configured' }); return true; }
    try {
      const metadata = JSON.parse(await readBody(req));
      const redirectUris = Array.isArray(metadata.redirect_uris) ? [...new Set(metadata.redirect_uris.map(String))] : [];
      if (!redirectUris.length || redirectUris.length > 10 || redirectUris.some(uri => !validRedirectUri(uri))) throw new Error('Valid redirect_uris are required');
      const client = {
        redirect_uris: redirectUris,
        client_name: String(metadata.client_name || 'ChatGPT MCP client').slice(0, 120),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        iat: Math.floor(Date.now() / 1000),
      };
      const clientId = createEnvelope('coread_client', client, secret);
      json(res, 201, { ...client, client_id: clientId, client_id_issued_at: client.iat });
    } catch (error) {
      json(res, error.status || 400, { error: 'invalid_client_metadata', error_description: error.message });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
    try {
      if (!secret) throw new Error('COREAD_ACCESS_TOKEN is not configured');
      validateAuthorization(url.searchParams, req, secret);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(authorizationPage(url.searchParams));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
    try {
      if (!secret) throw new Error('COREAD_ACCESS_TOKEN is not configured');
      const form = new URLSearchParams(await readBody(req));
      const authorization = validateAuthorization(form, req, secret);
      if (loginBlocked(req)) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '600' });
        res.end(authorizationPage(form, '尝试次数过多，请十分钟后再试。'));
        return true;
      }
      if (!safeEqual(form.get('token'), secret)) {
        recordFailedLogin(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(authorizationPage(form, '访问钥匙不正确，请重新输入。'));
        return true;
      }
      clearFailedLogins(req);
      cleanupCodes();
      const code = crypto.randomBytes(32).toString('base64url');
      authorizationCodes.set(code, { ...authorization, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
      const redirect = new URL(authorization.redirectUri);
      redirect.searchParams.set('code', code);
      if (form.get('state')) redirect.searchParams.set('state', form.get('state'));
      res.writeHead(303, { Location: redirect.toString(), 'Cache-Control': 'no-store' });
      res.end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    try {
      if (!secret) throw new Error('COREAD_ACCESS_TOKEN is not configured');
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') !== 'authorization_code') throw new Error('Unsupported grant_type');
      const code = String(form.get('code') || '');
      const pending = authorizationCodes.get(code);
      if (!pending || pending.expiresAt <= Date.now()) throw new Error('Invalid or expired authorization code');
      if (!safeEqual(form.get('client_id'), pending.clientId) || form.get('redirect_uri') !== pending.redirectUri) throw new Error('Authorization code binding mismatch');
      const verifier = String(form.get('code_verifier') || '');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(challenge, pending.codeChallenge)) throw new Error('PKCE verification failed');
      const requestedResource = String(form.get('resource') || pending.resource);
      if (requestedResource !== pending.resource) throw new Error('OAuth resource mismatch');
      authorizationCodes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      const accessToken = createEnvelope('coread_at', {
        sub: 'coread-owner', aud: pending.resource, scope: pending.scope,
        iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS, jti: crypto.randomUUID(),
      }, secret);
      json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: pending.scope }, { 'Access-Control-Allow-Origin': '*' });
    } catch (error) {
      json(res, 400, { error: 'invalid_grant', error_description: error.message }, { 'Access-Control-Allow-Origin': '*' });
    }
    return true;
  }

  if (req.method === 'OPTIONS' && url.pathname.startsWith('/oauth/')) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return true;
  }

  return false;
}
