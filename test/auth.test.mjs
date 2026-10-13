import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleAuthRoute, isAuthorized, rejectUnauthorized } from '../lib/auth.mjs';

function response() {
  return {
    headers: {},
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = body; },
  };
}

test('deployment auth accepts bearer and cookie, rejects unauthenticated APIs', async t => {
  const previous = process.env.COREAD_ACCESS_TOKEN;
  process.env.COREAD_ACCESS_TOKEN = 'secret value';
  t.after(() => previous == null ? delete process.env.COREAD_ACCESS_TOKEN : process.env.COREAD_ACCESS_TOKEN = previous);

  assert.equal(isAuthorized({ headers: { authorization: 'Bearer secret value' } }), true);
  assert.equal(isAuthorized({ headers: { cookie: 'coread_session=secret%20value' } }), true);
  assert.equal(isAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);

  const res = response();
  assert.equal(rejectUnauthorized({ method: 'POST', headers: {} }, res, new URL('https://coread.test/mcp')), true);
  assert.equal(res.status, 401);
  assert.match(res.headers['WWW-Authenticate'], /Bearer/);
  assert.match(res.headers['WWW-Authenticate'], /oauth-protected-resource/);
});

test('login exchanges the access token for an HttpOnly cookie', async t => {
  const previous = process.env.COREAD_ACCESS_TOKEN;
  process.env.COREAD_ACCESS_TOKEN = 'mobile-key';
  t.after(() => previous == null ? delete process.env.COREAD_ACCESS_TOKEN : process.env.COREAD_ACCESS_TOKEN = previous);

  const req = Readable.from(['token=mobile-key']);
  req.method = 'POST'; req.headers = { 'x-forwarded-proto': 'https' };
  const res = response();
  assert.equal(await handleAuthRoute(req, res, new URL('https://coread.test/auth/login')), true);
  assert.equal(res.status, 303);
  assert.match(res.headers['Set-Cookie'], /HttpOnly/);
  assert.match(res.headers['Set-Cookie'], /Secure/);
  assert.equal(res.headers.Location, '/');
});
