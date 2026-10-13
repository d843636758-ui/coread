import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './lib/db.mjs';
import { handleRequest } from './lib/routes.mjs';
import { createMcpHttpHandler } from './lib/mcp-http.mjs';
import { getAccessToken, handleAuthRoute, isAuthorized, rejectUnauthorized } from './lib/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || process.env.COREAD_PORT || '3000');
const DB_PATH = process.env.COREAD_DB || path.join(process.cwd(), 'data', 'coread.db');
const handleMcpHttp = createMcpHttpHandler();

// Optional comment notifier: run an arbitrary command whenever someone comments.
// COREAD_NOTIFY_CMD  — shell command to execute (comment details passed via env vars)
// COREAD_NOTIFY_FROM — only fire for this author (default 'human'; '*' = everyone)
// Env vars available to the command:
//   COREAD_BOOK_ID, COREAD_BOOK_TITLE, COREAD_FROM, COREAD_COMMENT
const NOTIFY_CMD = process.env.COREAD_NOTIFY_CMD || '';
const NOTIFY_FROM = process.env.COREAD_NOTIFY_FROM || 'human';

function notifyComment({ book_id, from_who, content }) {
  if (!NOTIFY_CMD) return;
  if (NOTIFY_FROM !== '*' && from_who !== NOTIFY_FROM) return;
  let title = `book#${book_id}`;
  try {
    const db = getDb(true);
    title = db.prepare('SELECT title FROM books WHERE id = ?').get(book_id)?.title || title;
    db.close();
  } catch {}
  execFile('/bin/sh', ['-c', NOTIFY_CMD], {
    timeout: 15000,
    env: {
      ...process.env,
      COREAD_BOOK_ID: String(book_id),
      COREAD_BOOK_TITLE: title,
      COREAD_FROM: from_who,
      COREAD_COMMENT: content || '',
    },
  }, (err) => { if (err) console.error('notify cmd error:', err.message); });
}

initDb(DB_PATH);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/healthz') {
    try {
      const db = getDb(true); db.prepare('SELECT 1').get(); db.close();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'coread' }));
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (await handleAuthRoute(req, res, url)) return;
  if (rejectUnauthorized(req, res, url)) return;

  // A browser authenticated by the deployment token is the room owner too.
  if (getAccessToken() && isAuthorized(req) && process.env.ROOM_OWNER_KEY && !req.headers['x-owner-key']) {
    req.headers['x-owner-key'] = process.env.ROOM_OWNER_KEY;
  }

  if (await handleMcpHttp(req, res, url)) return;
  const handled = await handleRequest(req, res, { port: PORT, onComment: notifyComment });
  if (handled) return;

  // Serve static files from public/
  const publicDir = path.join(__dirname, 'public');
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end('Bad request'); return; }
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(publicDir + path.sep)) { res.writeHead(404); res.end('Not found'); return; }
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, process.env.COREAD_HOST || '0.0.0.0', () => {
  console.log(`\n  📚 coread server running at http://localhost:${PORT}`);
  console.log(`  📂 Database: ${DB_PATH}`);
  console.log(`  🔗 MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  🔐 Access token: ${getAccessToken() ? 'enabled' : 'disabled (local/trusted networks only)'}`);
  console.log(`  🌐 Open http://localhost:${PORT} in your browser\n`);
});

function shutdown(signal) {
  console.log(`\n  ${signal} received, shutting down coread`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
