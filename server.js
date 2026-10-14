import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { createApi } from './lib/api.js';
import { createAuth, COOKIE } from './lib/auth.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dbFile = process.env.DB_FILE || path.join(root, 'data', 'raspisanie.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = openDb(dbFile);
const api = createApi(db);
const auth = createAuth(db);
const PORT = Number(process.env.PORT) || 3000;

const generated = auth.init(process.env.ADMIN_PASSWORD);
if (generated) {
  const file = path.join(path.dirname(dbFile), 'admin-password.txt');
  fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  console.log(`Создан пароль администратора: ${generated} (сохранён в ${file}). Сменить можно в «Настройках».`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Неверный JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(req, token, maxAge) {
  const secure = process.env.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// За прокси хостинга (TRUST_PROXY=1) берём адрес, который добавил сам прокси, — последний в списке.
const clientIp = req => (process.env.TRUST_PROXY && req.headers['x-forwarded-for']
  ? req.headers['x-forwarded-for'].split(',').pop().trim()
  : req.socket.remoteAddress);

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(publicDir)) return send(res, 403, { error: 'Запрещено' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // Неизвестные пути отдают приложение, чтобы работали прямые ссылки.
      return fs.readFile(path.join(publicDir, 'index.html'), (e2, html) => {
        if (e2) return send(res, 404, { error: 'Не найдено' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, decodeURIComponent(url.pathname));

    const route = url.pathname.slice(4);
    const token = getCookie(req, COOKIE);
    const admin = auth.check(token);

    if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      // Защита от отправки форм с чужих сайтов: изменения принимаются только как JSON.
      return send(res, 415, { error: 'Ожидается JSON' });
    }
    const body = req.method === 'GET' ? {} : await readJson(req);

    if (route === '/me' && req.method === 'GET') return send(res, 200, { admin });
    if (route === '/login' && req.method === 'POST') {
      const s = auth.login(body.password, clientIp(req));
      return send(res, 200, { admin: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }
    if (route === '/logout' && req.method === 'POST') {
      auth.logout(token);
      return send(res, 200, { admin: false }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (route === '/password' && req.method === 'PUT') {
      if (!admin) return send(res, 401, { error: 'Войдите как администратор' });
      auth.changePassword(body.current, body.next, token);
      return send(res, 200, { ok: true });
    }

    const result = api.handle(req.method, route, url.searchParams, body, { admin });
    send(res, 200, result ?? { ok: true });
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера' });
  }
}).listen(PORT, () => {
  console.log(`Расписание запущено: http://localhost:${PORT}`);
});
