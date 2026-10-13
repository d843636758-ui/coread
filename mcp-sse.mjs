#!/usr/bin/env node
import http from 'http';
import path from 'path';
import { initDb } from './lib/db.mjs';
import { createMcpHttpHandler } from './lib/mcp-http.mjs';
import { getAccessToken, rejectUnauthorized } from './lib/auth.mjs';
import { handleOAuthRoute } from './lib/oauth.mjs';

const DB_PATH = process.env.COREAD_DB || path.join(process.cwd(), 'data', 'coread.db');
const PORT = parseInt(process.env.COREAD_MCP_PORT || '3001');
const HOST = process.env.COREAD_MCP_HOST || '127.0.0.1';
const handleMcpHttp = createMcpHttpHandler();
initDb(DB_PATH);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (await handleOAuthRoute(req, res, url, getAccessToken())) return;
  if (rejectUnauthorized(req, res, url)) return;
  if (await handleMcpHttp(req, res, url)) return;
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  📚 coread MCP server (SSE + Streamable HTTP)`);
  console.log(`  🔗 SSE:              http://${HOST}:${PORT}/sse`);
  console.log(`  🔗 Streamable HTTP:  http://${HOST}:${PORT}/mcp`);
  console.log(`  🔐 Access token:     ${getAccessToken() ? 'enabled' : 'disabled'}`);
  console.log(`  📂 Database: ${DB_PATH}\n`);
});
