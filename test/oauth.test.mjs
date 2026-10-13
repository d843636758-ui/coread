import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Readable } from 'node:stream';
import { handleOAuthRoute } from '../lib/oauth.mjs';
import { isAuthorized } from '../lib/auth.mjs';

function request(method, body = '', headers = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.headers = { host: 'coread.test', 'x-forwarded-proto': 'https', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function response() {
  return {
    headers: {},
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = String(body); },
  };
}

test('OAuth discovery, DCR and PKCE authorization work end to end', async t => {
  const previousToken = process.env.COREAD_ACCESS_TOKEN;
  const previousUrl = process.env.COREAD_PUBLIC_URL;
  process.env.COREAD_ACCESS_TOKEN = 'oauth-secret';
  process.env.COREAD_PUBLIC_URL = 'https://coread.test';
  t.after(() => {
    previousToken == null ? delete process.env.COREAD_ACCESS_TOKEN : process.env.COREAD_ACCESS_TOKEN = previousToken;
    previousUrl == null ? delete process.env.COREAD_PUBLIC_URL : process.env.COREAD_PUBLIC_URL = previousUrl;
  });

  let res = response();
  assert.equal(await handleOAuthRoute(request('GET'), res, new URL('https://coread.test/.well-known/oauth-protected-resource'), 'oauth-secret'), true);
  assert.equal(JSON.parse(res.body).resource, 'https://coread.test/mcp');

  const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
  res = response();
  await handleOAuthRoute(
    request('POST', JSON.stringify({ redirect_uris: [redirectUri], client_name: 'ChatGPT' })),
    res,
    new URL('https://coread.test/oauth/register'),
    'oauth-secret',
  );
  assert.equal(res.status, 201);
  const clientId = JSON.parse(res.body).client_id;

  const verifier = 'v'.repeat(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const form = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'state-1',
    code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://coread.test/mcp',
    scope: 'coread', token: 'oauth-secret',
  });
  res = response();
  await handleOAuthRoute(request('POST', form.toString()), res, new URL('https://coread.test/oauth/authorize'), 'oauth-secret');
  assert.equal(res.status, 200);
  assert.match(res.body, /钥匙正确，授权成功/);
  assert.match(res.body, /返回 ChatGPT 完成连接/);
  const callbackUrl = res.body.match(/<a class="button" href="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
  const callback = new URL(callbackUrl);
  assert.equal(callback.searchParams.get('state'), 'state-1');
  const code = callback.searchParams.get('code');

  const exchange = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri,
    code_verifier: verifier, resource: 'https://coread.test/mcp',
  });
  res = response();
  await handleOAuthRoute(request('POST', exchange.toString()), res, new URL('https://coread.test/oauth/token'), 'oauth-secret');
  assert.equal(res.status, 200);
  const accessToken = JSON.parse(res.body).access_token;
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${accessToken}` } }), true);

  res = response();
  await handleOAuthRoute(request('POST', exchange.toString()), res, new URL('https://coread.test/oauth/token'), 'oauth-secret');
  assert.equal(res.status, 400, 'authorization codes are one-time use');
});
