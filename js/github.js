// Чтение и запись data.json в репозитории через GitHub API.
// Вход администратора = личный токен GitHub с правом записи в этот репозиторий.

const API = 'https://api.github.com';
const FILE = 'data.json';

export class ConflictError extends Error {}

// На GitHub Pages адрес вида owner.github.io/repo/ — из него понятно, какой это репозиторий.
export function detectRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return null;
  const owner = host.slice(0, -'.github.io'.length);
  const repo = location.pathname.split('/').filter(Boolean)[0] || host;
  return `${owner}/${repo}`;
}

async function call(conn, path, opts = {}) {
  const res = await fetch(API + path, {
    cache: 'no-store',
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${conn.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub не принял токен: проверьте, что он скопирован целиком и не истёк');
  if (res.status === 409 || (res.status === 422 && opts.method === 'PUT')) {
    throw new ConflictError('Данные на GitHub уже изменились');
  }
  if (res.status === 403 && opts.method !== 'PUT' && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub временно ограничил число запросов — попробуйте через несколько минут');
  }
  if (res.status === 403) {
    throw new Error('У токена не хватает прав. Откройте токен на GitHub → Edit: Repository access — «Only select repositories» с этим репозиторием, ' +
      'Permissions → Contents — «Read and write». Сохраните (Update) и войдите на сайте заново');
  }
  if (res.status === 404) throw new Error('Репозиторий не найден или у токена нет к нему доступа');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub: ${body.message ?? res.status}`);
  }
  return res;
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Проверяет токен и права. Возвращает подключение для loadData/saveData.
export async function connect(token, repoFull) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull ?? '')) throw new Error('Укажите репозиторий в виде владелец/название');
  const conn = { token: token.trim(), repo: repoFull };
  const info = await (await call(conn, `/repos/${repoFull}`)).json();
  if (!info.permissions?.push) throw new Error('У этого токена нет права записи в репозиторий (нужно Contents: Read and write)');
  conn.branch = info.default_branch;
  return conn;
}

export async function loadData(conn) {
  const path = `/repos/${conn.repo}/contents/${FILE}?ref=${encodeURIComponent(conn.branch)}`;
  const meta = await (await call(conn, path)).json();
  let text;
  if (meta.encoding === 'base64' && meta.content) {
    text = decodeBase64Utf8(meta.content);
  } else {
    // Файлы больше 1 МБ API отдаёт только «сырыми».
    text = await (await call(conn, path, { headers: { Accept: 'application/vnd.github.raw+json' } })).text();
  }
  return { data: JSON.parse(text), sha: meta.sha };
}

export async function saveData(conn, data, sha, message) {
  const res = await call(conn, `/repos/${conn.repo}/contents/${FILE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: encodeBase64Utf8(JSON.stringify(data)), sha, branch: conn.branch }),
  });
  return (await res.json()).content.sha;
}
