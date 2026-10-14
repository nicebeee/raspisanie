// Правила расписания (раздел 3 ТЗ) и учёт выполнения плана (раздел 8 ТЗ).

export const KINDS = ['lecture', 'practice', 'lab'];
export const KIND_NAMES = { lecture: 'Лекция', practice: 'Практическое', lab: 'Лабораторная' };

export const DEFAULT_SETTINGS = {
  pairs_per_day: 6,
  max_pairs: 4,
  hours_per_pair: 2,
  bells: [
    { pair: 1, start: '08:30', end: '10:00' },
    { pair: 2, start: '10:10', end: '11:40' },
    { pair: 3, start: '12:20', end: '13:50' },
    { pair: 4, start: '14:00', end: '15:30' },
    { pair: 5, start: '15:40', end: '17:10' },
    { pair: 6, start: '17:20', end: '18:50' },
  ],
};

export function loadSettings(db) {
  // Отдаём только известные настройки: в той же таблице лежит служебное (хэш пароля и т.п.).
  const rows = db.prepare('SELECT key, value FROM settings').all().filter(r => r.key in DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)])) };
}

// 1 = понедельник … 7 = воскресенье
export function weekdayOf(date) {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

// Вид занятия идёт по подгруппам, только если у группы есть подгруппы и в плане отмечено деление.
export function isSplitKind(item, kind, subgroupCount) {
  if (!subgroupCount) return false;
  return Boolean((kind === 'practice' && item.split_practice) || (kind === 'lab' && item.split_lab));
}

export const unitKey = (curriculumId, kind, subgroupId) => `${curriculumId}|${kind}|${subgroupId || 0}`;

// Сколько пар проведено по каждой единице плана (предмет × вид × подгруппа).
// Учитываются утверждённые дни; extraDate добавляет черновик этого дня.
export function computeProgress(db, extraDate = null) {
  const rows = db.prepare(`
    SELECT l.curriculum_id AS cid, l.kind, COALESCE(l.subgroup_id, 0) AS sid, COUNT(*) AS n
    FROM lessons l LEFT JOIN schedule_days d ON d.date = l.date
    WHERE l.status = 'active' AND (d.status = 'approved' OR l.date = ?)
    GROUP BY l.curriculum_id, l.kind, COALESCE(l.subgroup_id, 0)`).all(extraDate ?? '');
  const out = {};
  for (const r of rows) out[unitKey(r.cid, r.kind, r.sid)] = r.n;
  return out;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const ids = ls => ls.map(l => l.id);

export function validateDay(db, date) {
  const s = loadSettings(db);
  const issues = [];
  const add = (level, text, lessons = [], groupId = null) => issues.push({ level, text, lessonIds: ids(lessons), groupId });

  const lessons = db.prepare("SELECT * FROM lessons WHERE date = ? AND status = 'active'").all(date);
  if (!lessons.length) return issues;

  const byId = sql => new Map(db.prepare(sql).all().map(r => [r.id, r]));
  const teachers = byId('SELECT * FROM teachers');
  const rooms = byId('SELECT * FROM rooms');
  const groups = byId('SELECT * FROM study_groups');
  const subgroups = byId('SELECT * FROM subgroups');
  const curriculum = byId('SELECT * FROM curriculum');
  const subjects = byId('SELECT * FROM subjects');
  for (const g of groups.values()) g.subgroups = [];
  for (const sg of subgroups.values()) groups.get(sg.group_id)?.subgroups.push(sg);

  const wd = weekdayOf(date);
  const avail = new Map(db.prepare('SELECT * FROM availability WHERE weekday = ?').all(wd).map(a => [a.teacher_id, a]));
  const absent = new Set(db.prepare('SELECT teacher_id FROM absences WHERE date_from <= ? AND date_to >= ?')
    .all(date, date).map(r => r.teacher_id));
  const roomOwners = new Map();
  for (const t of teachers.values()) {
    if (t.room_id) roomOwners.set(t.room_id, [...(roomOwners.get(t.room_id) ?? []), t.id]);
  }

  const tName = id => teachers.get(id)?.short_name ?? '—';
  const who = l => {
    const g = groups.get(l.group_id);
    const sg = l.subgroup_id ? subgroups.get(l.subgroup_id) : null;
    return (g?.name ?? '?') + (sg ? ` (${sg.name})` : '');
  };
  const subjName = l => subjects.get(curriculum.get(l.curriculum_id)?.subject_id)?.name ?? '?';

  if (wd === 7) add('error', 'Воскресенье — не учебный день', lessons);

  // Проверки каждого занятия
  for (const l of lessons) {
    const g = groups.get(l.group_id);
    const item = curriculum.get(l.curriculum_id);
    const subj = subjects.get(item?.subject_id);
    const t = teachers.get(l.teacher_id);
    const r = rooms.get(l.room_id);
    const where = `${who(l)}, ${l.pair}-я пара`;

    if (l.pair < 1 || l.pair > s.pairs_per_day) add('error', `${where}: такой пары нет в сетке звонков`, [l]);

    if (!t) {
      add('error', `${where}: не указан преподаватель`, [l]);
    } else {
      const a = avail.get(t.id);
      if (!a) add('error', `${where}: ${t.short_name} не работает в этот день недели`, [l]);
      else if (l.pair < a.pair_from || l.pair > a.pair_to) {
        add('error', `${where}: ${t.short_name} доступен только с ${a.pair_from} по ${a.pair_to} пару`, [l]);
      }
      if (absent.has(t.id)) add('error', `${where}: ${t.short_name} отсутствует в этот день`, [l]);
      if (t.room_id && l.room_id !== t.room_id) {
        add('error', `${where}: ${t.short_name} ведёт занятия только в закреплённой аудитории ${rooms.get(t.room_id)?.name}`, [l]);
      }
    }

    if (!r) {
      add('warning', `${where}: не указана аудитория`, [l]);
    } else {
      const owners = roomOwners.get(r.id);
      if (owners && !owners.includes(l.teacher_id)) {
        add('warning', `${where}: аудитория ${r.name} закреплена за ${owners.map(tName).join(', ')}`, [l]);
      }
      const people = l.subgroup_id ? Math.ceil((g?.size ?? 0) / Math.max(1, g?.subgroups.length ?? 1)) : (g?.size ?? 0);
      if (r.capacity && people > r.capacity) {
        add('warning', `${where}: в аудитории ${r.name} ${r.capacity} мест, а студентов ${people}`, [l]);
      }
      if (subj?.room_type && r.type !== subj.room_type) {
        add('warning', `${where}: для предмета «${subj.name}» нужна аудитория типа «${subj.room_type}»`, [l]);
      }
    }

    if (!item || item.group_id !== l.group_id) {
      add('error', `${where}: предмета нет в учебном плане группы`, [l]);
    } else {
      const split = isSplitKind(item, l.kind, g?.subgroups.length);
      const kindName = KIND_NAMES[l.kind].toLowerCase();
      if (l.subgroup_id && !split) add('error', `${where}: ${kindName} по «${subj?.name}» проводится для всей группы, не по подгруппам`, [l]);
      if (!l.subgroup_id && split) add('error', `${where}: ${kindName} по «${subj?.name}» проводится по подгруппам`, [l]);
    }
  }

  // Преподаватель и аудитория — не больше одного занятия в одну пару
  for (const ls of groupBy(lessons, l => (l.teacher_id ? `${l.pair}|${l.teacher_id}` : null)).values()) {
    if (ls.length > 1) add('error', `${ls[0].pair}-я пара: ${tName(ls[0].teacher_id)} одновременно ведёт занятия у ${ls.map(who).join(', ')}`, ls);
  }
  for (const ls of groupBy(lessons, l => (l.room_id ? `${l.pair}|${l.room_id}` : null)).values()) {
    if (ls.length > 1) add('error', `${ls[0].pair}-я пара: в аудитории ${rooms.get(ls[0].room_id)?.name} одновременно ${ls.map(who).join(', ')}`, ls);
  }

  // Группа и подгруппы: накладки, лимит пар, окна
  for (const g of groups.values()) {
    const gl = lessons.filter(l => l.group_id === g.id);
    if (!gl.length) continue;

    for (const at of groupBy(gl, l => l.pair).values()) {
      const whole = at.filter(l => !l.subgroup_id);
      const sub = at.filter(l => l.subgroup_id);
      const p = at[0].pair;
      if (whole.length > 1) add('error', `${g.name}, ${p}-я пара: у группы несколько занятий одновременно`, whole, g.id);
      if (whole.length && sub.length) add('error', `${g.name}, ${p}-я пара: общая пара группы совпадает с парой подгруппы`, at, g.id);
      for (const same of groupBy(sub, l => l.subgroup_id).values()) {
        if (same.length > 1) add('error', `${who(same[0])}, ${p}-я пара: у подгруппы несколько занятий одновременно`, same, g.id);
      }
    }

    // Лимит и окна считаются для каждой подгруппы отдельно: её пары + общие пары группы.
    const streams = g.subgroups.length
      ? g.subgroups.map(sg => ({ name: `${g.name} (${sg.name})`, ls: gl.filter(l => !l.subgroup_id || l.subgroup_id === sg.id) }))
      : [{ name: g.name, ls: gl }];
    for (const st of streams) {
      const pairs = [...new Set(st.ls.map(l => l.pair))].sort((a, b) => a - b);
      if (!pairs.length) continue;
      if (pairs.length > s.max_pairs) {
        add('error', `${st.name}: ${pairs.length} пар за день, допустимо не более ${s.max_pairs}`, st.ls, g.id);
      }
      const gaps = [];
      for (let p = pairs[0]; p <= pairs[pairs.length - 1]; p++) if (!pairs.includes(p)) gaps.push(p);
      if (gaps.length) {
        add('error', `${st.name}: окно на ${gaps.join(', ')}-й паре — пары должны идти подряд`, st.ls, g.id);
      }
    }
  }

  // Превышение часов учебного плана (с учётом этого дня)
  const progress = computeProgress(db, date);
  for (const [key, ls] of groupBy(lessons, l => unitKey(l.curriculum_id, l.kind, l.subgroup_id))) {
    const item = curriculum.get(ls[0].curriculum_id);
    if (!item) continue;
    const planned = item['h_' + ls[0].kind] / s.hours_per_pair;
    if ((progress[key] ?? 0) > planned) {
      add('warning', `${who(ls[0])}: «${subjName(ls[0])}», ${KIND_NAMES[ls[0].kind].toLowerCase()} — сверх плана (${progress[key]} из ${planned} пар)`, ls);
    }
  }

  return issues;
}
