import crypto from 'node:crypto';

const SESSION_DAYS = 30;
export const COOKIE = 'rasp_session';

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verify(password, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(h, 'hex'));
}

export function createAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  )`);
  const getHash = () => db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get()?.value;
  const setPassword = password =>
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)").run(hash(password));

  // Неудачные попытки входа по IP: не больше 10 за 15 минут.
  const attempts = new Map();
  const WINDOW = 15 * 60 * 1000;

  return {
    // Пароль из переменной ADMIN_PASSWORD главнее сохранённого.
    // Если пароля нет совсем — создаём случайный и возвращаем его, чтобы показать при запуске.
    init(envPassword) {
      if (envPassword) {
        setPassword(envPassword);
        return null;
      }
      if (getHash()) return null;
      const generated = crypto.randomBytes(6).toString('base64url');
      setPassword(generated);
      return generated;
    },

    login(password, ip) {
      const now = Date.now();
      const recent = (attempts.get(ip) ?? []).filter(t => now - t < WINDOW);
      if (recent.length >= 10) {
        throw Object.assign(new Error('Слишком много попыток. Попробуйте через 15 минут'), { status: 429 });
      }
      if (typeof password !== 'string' || !verify(password, getHash())) {
        attempts.set(ip, [...recent, now]);
        throw Object.assign(new Error('Неверный пароль'), { status: 401 });
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(now + SESSION_DAYS * 864e5).toISOString();
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
      db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expires);
      return { token, maxAge: SESSION_DAYS * 86400 };
    },

    check(token) {
      if (!token) return false;
      const s = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
      return Boolean(s && s.expires_at > new Date().toISOString());
    },

    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },

    // Смена пароля завершает все остальные сессии.
    changePassword(current, next, keepToken) {
      if (!verify(String(current ?? ''), getHash())) {
        throw Object.assign(new Error('Текущий пароль указан неверно'), { status: 400 });
      }
      if (typeof next !== 'string' || next.length < 8) {
        throw Object.assign(new Error('Новый пароль — не короче 8 символов'), { status: 400 });
      }
      setPassword(next);
      db.prepare('DELETE FROM sessions WHERE token <> ?').run(keepToken ?? '');
    },
  };
}
