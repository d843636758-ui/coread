import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMcpHttpHandler } from '../lib/mcp-http.mjs';

function request(payload) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = 'POST'; req.headers = {};
  return req;
}

function response() {
  return {
    headers: {}, chunks: [],
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    write(chunk) { this.chunks.push(String(chunk)); },
    end(body = '') { this.body = String(body); },
  };
}

test('single-domain MCP endpoint initializes and lists tools', async t => {
  const previous = process.env.COREAD_ACCESS_TOKEN;
  process.env.COREAD_ACCESS_TOKEN = 'test-secret';
  t.after(() => previous == null ? delete process.env.COREAD_ACCESS_TOKEN : process.env.COREAD_ACCESS_TOKEN = previous);
  const handler = createMcpHttpHandler();
  let res = response();
  assert.equal(await handler(request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }), res, new URL('https://coread.test/mcp')), true);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).result.serverInfo.name, 'coread');
  assert.equal(JSON.parse(res.body).result.protocolVersion, '2025-06-18');

  res = response();
  await handler(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), res, new URL('https://coread.test/mcp'));
  const names = JSON.parse(res.body).result.tools.map(tool => tool.name);
  assert.ok(names.includes('read_book'));
  assert.ok(names.includes('add_comment'));
  assert.equal(JSON.parse(res.body).result.tools[0].securitySchemes[0].type, 'oauth2');
});
