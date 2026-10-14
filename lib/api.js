import { KINDS, computeProgress, loadSettings, validateDay } from './logic.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = msg => new HttpError(400, msg);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d) || Number.isNaN(Date.parse(d))) throw bad('Неверная дата');
  return d;
}
function shiftDate(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const fmtDate = d => d.split('-').reverse().join('.');

const LABELS = {
  name: 'Название', full_name: 'ФИО', short_name: 'Краткое имя', group_id: 'Группа',
  subject_id: 'Предмет', teacher_id: 'Преподаватель', date_from: 'С', date_to: 'По',
};

// Справочники: какие поля принимаем и какого они типа ("!" — обязательное).
const TABLES = {
  rooms: { table: 'rooms', fields: { name: 'text!', building: 'text', capacity: 'int', type: 'text' } },
  subjects: { table: 'subjects', fields: { name: 'text!', room_type: 'text' } },
  teachers: { table: 'teachers', fields: { full_name: 'text!', short_name: 'text!', room_id: 'int', active: 'bool' } },
  groups: { table: 'study_groups', fields: { name: 'text!', specialty: 'text', course: 'int', size: 'int' } },
  curriculum: {
    table: 'curriculum',
    fields: {
      group_id: 'int!', subject_id: 'int!', teacher_id: 'int', semester: 'int',
      h_lecture: 'int', h_practice: 'int', h_lab: 'int', split_practice: 'bool', split_lab: 'bool',
    },
  },
  absences: { table: 'absences', fields: { teacher_id: 'int!', date_from: 'date!', date_to: 'date!', reason: 'text' } },
};

function clean(def, body) {
  const out = {};
  for (const [f, spec] of Object.entries(def.fields)) {
    const required = spec.endsWith('!');
    const type = spec.replace('!', '');
    let v = body[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      if (type === 'int') {
        v = Number(v);
        if (!Number.isInteger(v) || v < 0) throw bad(`Поле «${LABELS[f] ?? f}»: нужно целое неотрицательное число`);
      } else if (type === 'bool') {
        v = v ? 1 : 0;
      } else if (type === 'date') {
        checkDate(v);
      } else {
        v = String(v).trim() || null;
      }
    }
    if (required && v === null) throw bad(`Заполните поле «${LABELS[f] ?? f}»`);
    if (v === null && type === 'bool') v = f === 'active' ? 1 : 0;
    if (v === null && type === 'text') v = '';
    if (v === null && f.startsWith('h_')) v = 0;
    out[f] = v;
  }
  return out;
}

export function createApi(db) {
  const nz = v => (v === undefined ? null : v);
  const all = (sql, ...p) => db.prepare(sql).all(...p.map(nz));
  const get = (sql, ...p) => db.prepare(sql).get(...p.map(nz));
  const run = (sql, ...p) => db.prepare(sql).run(...p.map(nz));
  const tx = fn => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const log = (date, action, details) =>
    run('INSERT INTO change_log (at, date, action, details) VALUES (?, ?, ?, ?)', new Date().toISOString(), date, action, details);

  const routes = [];
  // По умолчанию маршрут только для администратора; { public: true } — доступен всем.
  const on = (method, pattern, fn, opts = {}) =>
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, public: !!opts.public });

  // ---------- Справочники ----------

  function bootstrap() {
    return {
      settings: loadSettings(db),
      rooms: all('SELECT * FROM rooms ORDER BY name'),
      teachers: all('SELECT * FROM teachers ORDER BY short_name').map(t => ({
        ...t,
        availability: all('SELECT weekday, pair_from, pair_to FROM availability WHERE teacher_id = ? ORDER BY weekday', t.id),
        absences: all('SELECT * FROM absences WHERE teacher_id = ? ORDER BY date_from DESC', t.id),
      })),
      groups: all('SELECT * FROM study_groups ORDER BY name').map(g => ({
        ...g,
        subgroups: all('SELECT * FROM subgroups WHERE group_id = ? ORDER BY name, id', g.id),
      })),
      subjects: all('SELECT * FROM subjects ORDER BY name'),
      curriculum: all('SELECT * FROM curriculum ORDER BY id'),
      progress: computeProgress(db),
    };
  }
  on('GET', '/bootstrap', bootstrap);

  // Для гостей — только то, что нужно для показа расписания (без отсутствий, плана и нагрузки).
  on('GET', '/public/bootstrap', () => {
    const s = loadSettings(db);
    return {
      settings: { bells: s.bells, pairs_per_day: s.pairs_per_day },
      rooms: all('SELECT id, name FROM rooms ORDER BY name'),
      teachers: all('SELECT id, short_name FROM teachers WHERE active = 1 ORDER BY short_name'),
      groups: all('SELECT id, name FROM study_groups ORDER BY name').map(g => ({
        ...g,
        subgroups: all('SELECT id, name FROM subgroups WHERE group_id = ? ORDER BY name, id', g.id),
      })),
      subjects: all('SELECT id, name FROM subjects ORDER BY name'),
      curriculum: all('SELECT id, group_id, subject_id FROM curriculum'),
    };
  }, { public: true });

  const afterSave = {
    teachers(id, body) {
      if (!Array.isArray(body.availability)) return;
      run('DELETE FROM availability WHERE teacher_id = ?', id);
      const s = loadSettings(db);
      for (const a of body.availability) {
        const wd = Number(a.weekday), from = Number(a.pair_from), to = Number(a.pair_to);
        if (!(wd >= 1 && wd <= 6) || !(from >= 1 && to <= s.pairs_per_day && from <= to)) {
          throw bad('Доступность: пары указаны неверно (должно быть «с» ≤ «по»)');
        }
        run('INSERT INTO availability (teacher_id, weekday, pair_from, pair_to) VALUES (?, ?, ?, ?)', id, wd, from, to);
      }
    },
    groups(id, body) {
      if (!Array.isArray(body.subgroups)) return;
      const keep = new Set();
      for (const sg of body.subgroups) {
        const name = String(sg.name ?? '').trim();
        if (!name) throw bad('Укажите название подгруппы');
        if (sg.id) {
          run('UPDATE subgroups SET name = ? WHERE id = ? AND group_id = ?', name, sg.id, id);
          keep.add(Number(sg.id));
        } else {
          keep.add(Number(run('INSERT INTO subgroups (group_id, name) VALUES (?, ?)', id, name).lastInsertRowid));
        }
      }
      for (const { id: sid } of all('SELECT id FROM subgroups WHERE group_id = ?', id)) {
        if (!keep.has(sid)) run('DELETE FROM subgroups WHERE id = ?', sid);
      }
    },
  };

  function friendly(e) {
    if (/UNIQUE/.test(e.message)) return bad('Запись с таким названием уже есть');
    if (/FOREIGN KEY/.test(e.message)) return bad('Связанная запись не найдена');
    return e;
  }

  for (const [name, def] of Object.entries(TABLES)) {
    on('POST', `/${name}`, (_, body) => {
      const row = clean(def, body);
      const cols = Object.keys(row);
      try {
        return tx(() => {
          const id = Number(run(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            ...Object.values(row)).lastInsertRowid);
          afterSave[name]?.(id, body);
          return { id };
        });
      } catch (e) { throw friendly(e); }
    });
    on('PUT', `/${name}/:id`, ({ id }, body) => {
      const row = clean(def, body);
      try {
        return tx(() => {
          const r = run(`UPDATE ${def.table} SET ${Object.keys(row).map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
            ...Object.values(row), Number(id));
          if (!r.changes) throw new HttpError(404, 'Запись не найдена');
          afterSave[name]?.(Number(id), body);
          return { id: Number(id) };
        });
      } catch (e) { throw friendly(e); }
    });
    on('DELETE', `/${name}/:id`, ({ id }) => {
      run(`DELETE FROM ${def.table} WHERE id = ?`, Number(id));
      return { ok: true };
    });
  }

  on('POST', '/curriculum/copy', (_, body) => {
    const from = Number(body.from_group), to = Number(body.to_group);
    if (!get('SELECT id FROM study_groups WHERE id = ?', to)) throw bad('Группа не найдена');
    if (from === to) throw bad('Выберите другую группу');
    const items = all('SELECT * FROM curriculum WHERE group_id = ?', from);
    tx(() => {
      for (const c of items) {
        run(`INSERT INTO curriculum (group_id, subject_id, teacher_id, semester, h_lecture, h_practice, h_lab, split_practice, split_lab)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        to, c.subject_id, c.teacher_id, c.semester, c.h_lecture, c.h_practice, c.h_lab, c.split_practice, c.split_lab);
      }
    });
    return { copied: items.length };
  });

  on('PUT', '/settings', (_, body) => {
    const s = loadSettings(db);
    const maxPairs = Number(body.max_pairs ?? s.max_pairs);
    const hpp = Number(body.hours_per_pair ?? s.hours_per_pair);
    const bells = body.bells ?? s.bells;
    if (!(Number.isInteger(maxPairs) && maxPairs >= 1 && maxPairs <= s.pairs_per_day)) throw bad(`Лимит пар — от 1 до ${s.pairs_per_day}`);
    if (!(Number.isInteger(hpp) && hpp >= 1 && hpp <= 4)) throw bad('Часов в паре — от 1 до 4');
    if (!Array.isArray(bells) || bells.length !== s.pairs_per_day ||
        bells.some(b => !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end))) {
      throw bad('Сетка звонков заполнена неверно');
    }
    const save = (k, v) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
    tx(() => {
      save('max_pairs', maxPairs);
      save('hours_per_pair', hpp);
      save('bells', bells.map((b, i) => ({ pair: i + 1, start: b.start, end: b.end })));
    });
    return loadSettings(db);
  });

  // ---------- Расписание на день ----------

  const ensureDay = date => run("INSERT OR IGNORE INTO schedule_days (date, status) VALUES (?, 'draft')", date);
  const dayStatus = date => get('SELECT status FROM schedule_days WHERE date = ?', date)?.status ?? 'draft';

  function dayPayload(date) {
    const day = get('SELECT * FROM schedule_days WHERE date = ?', date);
    return {
      date,
      status: day?.status ?? 'draft',
      approved_at: day?.approved_at ?? null,
      lessons: all('SELECT * FROM lessons WHERE date = ? ORDER BY pair, subgroup_id', date),
      issues: validateDay(db, date),
      progress: computeProgress(db, date),
    };
  }

  on('GET', '/day/:date', ({ date }) => dayPayload(checkDate(date)));

  // Полностью заменяет занятия группы в одной паре (вся группа или по подгруппам).
  on('PUT', '/day/:date/cell', ({ date }, body) => {
    checkDate(date);
    const s = loadSettings(db);
    const group = get('SELECT * FROM study_groups WHERE id = ?', body.group_id);
    if (!group) throw bad('Группа не найдена');
    const pair = Number(body.pair);
    if (!(Number.isInteger(pair) && pair >= 1 && pair <= s.pairs_per_day)) throw bad('Неверный номер пары');
    const subIds = new Set(all('SELECT id FROM subgroups WHERE group_id = ?', group.id).map(r => r.id));

    const list = (body.lessons ?? []).map(x => {
      const item = get('SELECT * FROM curriculum WHERE id = ?', x.curriculum_id);
      if (!item || item.group_id !== group.id) throw bad('Предмет не найден в учебном плане группы');
      if (!KINDS.includes(x.kind)) throw bad('Выберите вид занятия');
      if (!item['h_' + x.kind]) throw bad('В плане нет часов этого вида занятий');
      const sid = x.subgroup_id ? Number(x.subgroup_id) : null;
      if (sid !== null && !subIds.has(sid)) throw bad('Подгруппа не найдена');
      const teacherId = x.teacher_id ? Number(x.teacher_id) : item.teacher_id;
      const teacher = teacherId ? get('SELECT * FROM teachers WHERE id = ?', teacherId) : null;
      if (teacherId && !teacher) throw bad('Преподаватель не найден');
      // Преподаватель с закреплённой аудиторией всегда ведёт занятия в ней.
      const roomId = teacher?.room_id ?? (x.room_id ? Number(x.room_id) : null);
      return { sid, cid: item.id, kind: x.kind, teacherId, roomId };
    });
    if (new Set(list.map(l => l.sid ?? 0)).size !== list.length) throw bad('Два занятия для одной подгруппы в одной паре');
    if (list.some(l => l.sid === null) && list.length > 1) throw bad('Общая пара группы не может идти одновременно с парой подгруппы');

    tx(() => {
      ensureDay(date);
      const before = run("DELETE FROM lessons WHERE date = ? AND group_id = ? AND pair = ? AND status = 'active'",
        date, group.id, pair).changes;
      for (const l of list) {
        run(`INSERT INTO lessons (date, pair, group_id, subgroup_id, curriculum_id, kind, teacher_id, room_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, date, pair, group.id, l.sid, l.cid, l.kind, l.teacherId, l.roomId);
      }
      log(date, 'Изменение пары', `${group.name}, ${pair}-я пара: было занятий ${before}, стало ${list.length}` +
        (dayStatus(date) === 'approved' ? ' (в утверждённом расписании)' : ''));
    });
    return dayPayload(date);
  });

  // Перенос пары группы на другую пару того же дня (обмен местами).
  on('POST', '/day/:date/move', ({ date }, body) => {
    checkDate(date);
    const s = loadSettings(db);
    const gid = Number(body.group_id), from = Number(body.from), to = Number(body.to);
    const ok = p => Number.isInteger(p) && p >= 1 && p <= s.pairs_per_day;
    if (!ok(from) || !ok(to) || from === to) throw bad('Неверный номер пары');
    const group = get('SELECT name FROM study_groups WHERE id = ?', gid);
    if (!group) throw bad('Группа не найдена');
    tx(() => {
      const q = "UPDATE lessons SET pair = ? WHERE date = ? AND group_id = ? AND pair = ? AND status = 'active'";
      run(q, -1, date, gid, from);
      run(q, from, date, gid, to);
      run(q, to, date, gid, -1);
      log(date, 'Перенос пары', `${group.name}: ${from}-я ↔ ${to}-я пара`);
    });
    return dayPayload(date);
  });

  function setLessonStatus(id, status) {
    const l = get('SELECT * FROM lessons WHERE id = ?', Number(id));
    if (!l) throw new HttpError(404, 'Занятие не найдено');
    if (status === 'active') {
      const clash = get(`SELECT id FROM lessons WHERE date = ? AND group_id = ? AND pair = ? AND status = 'active'
                         AND (subgroup_id IS NULL OR ? IS NULL OR subgroup_id = ?)`,
      l.date, l.group_id, l.pair, l.subgroup_id, l.subgroup_id);
      if (clash) throw bad('На этой паре уже стоит другое занятие — сначала уберите его');
    }
    run('UPDATE lessons SET status = ? WHERE id = ?', status, l.id);
    const g = get('SELECT name FROM study_groups WHERE id = ?', l.group_id);
    log(l.date, status === 'cancelled' ? 'Отмена пары' : 'Возврат пары', `${g?.name}, ${l.pair}-я пара`);
    return dayPayload(l.date);
  }
  on('POST', '/lessons/:id/cancel', ({ id }) => setLessonStatus(id, 'cancelled'));
  on('POST', '/lessons/:id/restore', ({ id }) => setLessonStatus(id, 'active'));

  on('POST', '/day/:date/approve', ({ date }) => {
    checkDate(date);
    if (!get("SELECT id FROM lessons WHERE date = ? AND status = 'active'", date)) throw bad('В расписании нет ни одной пары');
    const errors = validateDay(db, date).filter(i => i.level === 'error');
    if (errors.length) throw bad(`Нельзя утвердить: в расписании ошибок — ${errors.length}`);
    ensureDay(date);
    run("UPDATE schedule_days SET status = 'approved', approved_at = ? WHERE date = ?", new Date().toISOString(), date);
    log(date, 'Утверждение', `Расписание на ${fmtDate(date)} утверждено`);
    return dayPayload(date);
  });

  on('POST', '/day/:date/unapprove', ({ date }) => {
    checkDate(date);
    run("UPDATE schedule_days SET status = 'draft', approved_at = NULL WHERE date = ?", date);
    log(date, 'Возврат в черновик', `Расписание на ${fmtDate(date)} снова черновик`);
    return dayPayload(date);
  });

  on('POST', '/day/:date/copy', ({ date }, body) => {
    checkDate(date);
    const from = checkDate(body.from ?? shiftDate(date, -7));
    if (dayStatus(date) === 'approved') throw bad('Расписание утверждено — сначала верните его в черновик');
    if (get("SELECT id FROM lessons WHERE date = ? AND status = 'active'", date)) throw bad('Сначала очистите расписание на этот день');
    const src = all("SELECT * FROM lessons WHERE date = ? AND status = 'active'", from);
    if (!src.length) throw bad(`На ${fmtDate(from)} расписания нет`);
    tx(() => {
      ensureDay(date);
      for (const l of src) {
        run(`INSERT INTO lessons (date, pair, group_id, subgroup_id, curriculum_id, kind, teacher_id, room_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, date, l.pair, l.group_id, l.subgroup_id, l.curriculum_id, l.kind, l.teacher_id, l.room_id);
      }
      log(date, 'Копирование', `Скопировано ${src.length} занятий с ${fmtDate(from)}`);
    });
    return dayPayload(date);
  });

  on('DELETE', '/day/:date', ({ date }) => {
    checkDate(date);
    if (dayStatus(date) === 'approved') throw bad('Расписание утверждено — сначала верните его в черновик');
    run('DELETE FROM lessons WHERE date = ?', date);
    log(date, 'Очистка', `Расписание на ${fmtDate(date)} очищено`);
    return dayPayload(date);
  });

  // ---------- Просмотр и отчёты ----------

  on('GET', '/view', (_, __, qs, ctx) => {
    const from = checkDate(qs.get('from')), to = checkDate(qs.get('to'));
    const col = { group: 'group_id', teacher: 'teacher_id', room: 'room_id' }[qs.get('type')];
    if (!col) throw bad('Неверный тип просмотра');
    const drafts = ctx.admin && qs.get('drafts') === '1' ? 1 : 0;
    return {
      lessons: all(`SELECT l.*, COALESCE(d.status, 'draft') AS day_status
                    FROM lessons l LEFT JOIN schedule_days d ON d.date = l.date
                    WHERE l.date BETWEEN ? AND ? AND l.${col} = ? AND (d.status = 'approved' OR ? = 1)
                    ORDER BY l.date, l.pair`, from, to, Number(qs.get('id')), drafts),
    };
  }, { public: true });

  on('GET', '/report/teachers', () => {
    const s = loadSettings(db);
    const subCount = new Map(all('SELECT group_id, COUNT(*) AS n FROM subgroups GROUP BY group_id').map(r => [r.group_id, r.n]));
    const plannedH = new Map();
    for (const c of all('SELECT * FROM curriculum WHERE teacher_id IS NOT NULL')) {
      const n = subCount.get(c.group_id) ?? 0;
      const h = c.h_lecture + c.h_practice * (c.split_practice && n ? n : 1) + c.h_lab * (c.split_lab && n ? n : 1);
      plannedH.set(c.teacher_id, (plannedH.get(c.teacher_id) ?? 0) + h);
    }
    const monthStart = new Date().toISOString().slice(0, 8) + '01';
    const doneBy = since => new Map(all(`SELECT l.teacher_id, COUNT(*) AS n FROM lessons l JOIN schedule_days d ON d.date = l.date
                                         WHERE d.status = 'approved' AND l.status = 'active' AND l.date >= ?
                                         GROUP BY l.teacher_id`, since).map(r => [r.teacher_id, r.n]));
    const done = doneBy('0000-00-00'), month = doneBy(monthStart);
    return {
      hours_per_pair: s.hours_per_pair,
      rows: all('SELECT id, short_name FROM teachers ORDER BY short_name').map(t => ({
        id: t.id,
        name: t.short_name,
        planned_h: plannedH.get(t.id) ?? 0,
        done_h: (done.get(t.id) ?? 0) * s.hours_per_pair,
        month_h: (month.get(t.id) ?? 0) * s.hours_per_pair,
      })),
    };
  });

  on('GET', '/log', () => all('SELECT * FROM change_log ORDER BY id DESC LIMIT 200'));

  return {
    handle(method, path, query, body, ctx = { admin: false }) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        if (!r.public && !ctx.admin) throw new HttpError(401, 'Войдите как администратор');
        return r.fn({ ...m.groups }, body ?? {}, query, ctx);
      }
      throw new HttpError(404, 'Не найдено');
    },
  };
}
