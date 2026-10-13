import crypto from 'crypto';
import { tools, handleTool } from './mcp-tools.mjs';

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleJsonRpc(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return jsonRpcError(msg?.id, -32600, 'Invalid Request');
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'coread', version: '0.1.0' },
    }};
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools } };
  if (msg.method === 'tools/call') {
    try {
      const result = await Promise.resolve(handleTool(msg.params?.name, msg.params?.arguments || {}));
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result?.error,
      }};
    } catch (error) {
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      }};
    }
  }
  if (msg.id !== undefined) return jsonRpcError(msg.id, -32601, 'Method not found');
  return null;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-coread-token, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) reject(Object.assign(new Error('Request too large'), { status: 413 }));
      else chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createMcpHttpHandler() {
  const sessions = new Map();

  return async function handleMcpHttp(req, res, url) {
    if (!['/mcp', '/sse', '/messages'].includes(url.pathname)) return false;
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      sessions.set(sessionId, res);
      res.on('close', () => sessions.delete(sessionId));
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const stream = sessions.get(sessionId);
      if (!stream) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
        return true;
      }
      try {
        const response = await handleJsonRpc(await readJson(req));
        res.writeHead(202); res.end();
        if (response) sendSse(stream, 'message', response);
      } catch (error) {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      try {
        const payload = await readJson(req);
        const response = Array.isArray(payload)
          ? (await Promise.all(payload.map(handleJsonRpc))).filter(Boolean)
          : await handleJsonRpc(payload);
        if (response == null || (Array.isArray(response) && response.length === 0)) {
          res.writeHead(202); res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(response));
        }
      } catch (error) {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonRpcError(null, -32700, error.message)));
      }
      return true;
    }

    if (req.method === 'DELETE' && url.pathname === '/mcp') { res.writeHead(204); res.end(); return true; }
    res.writeHead(405, { Allow: url.pathname === '/sse' ? 'GET, OPTIONS' : 'POST, DELETE, OPTIONS' });
    res.end('Method not allowed');
    return true;
  };
}
