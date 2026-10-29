// Правила расписания (раздел 3 ТЗ) и учёт выполнения плана (раздел 8 ТЗ).
// Модуль без зависимостей: работает и в браузере, и в тестах Node.

export const KINDS = ['lecture', 'practice', 'lab'];
export const KIND_NAMES = { lecture: 'Лекция', practice: 'Практическое', lab: 'Лабораторная' };

export const DEFAULT_SETTINGS = {
  pairs_per_day: 6,
  min_pairs: 4, // у группы/подгруппы в день: не меньше (предупреждение) …
  max_pairs: 6, // … и не больше (ошибка)
  teacher_max_pairs: 4,
  max_same_subject: 1, // сколько раз один предмет может стоять у группы/подгруппы в один день
  study_days: 5, // учебных дней в неделе: 5 (пн–пт) или 6 (пн–сб)
  semester1_end: null, // последний день 1-го семестра, ГГГГ-ММ-ДД
  semester2_end: null, // последний день 2-го семестра
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

export function settingsOf(data) {
  const saved = { ...data.settings };
  // Старый формат: был только «максимум пар» = 4. Переходим на «от 4 до 6».
  if (saved.min_pairs === undefined) delete saved.max_pairs;
  return { ...DEFAULT_SETTINGS, ...saved };
}

// Какой сейчас семестр по датам окончания из настроек (1, 2 или null, если даты не заданы).
export function semesterOf(data, date) {
  const s = settingsOf(data);
  if (s.semester1_end && date <= s.semester1_end) return 1;
  if (s.semester2_end && date <= s.semester2_end) return 2;
  return null;
}

// Сколько учебных дней осталось до конца текущего семестра, включая date (null — даты не заданы).
export function studyDaysLeft(data, date) {
  const s = settingsOf(data);
  const sem = semesterOf(data, date);
  const end = sem === 1 ? s.semester1_end : sem === 2 ? s.semester2_end : null;
  if (!end) return null;
  let n = 0;
  for (let d = new Date(date + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (wd <= s.study_days) n++;
  }
  return n;
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

// Кто ведёт вид занятий у подгруппы: отдельное назначение для подгруппы, для вида занятий,
// иначе основной преподаватель предмета. item.teachers = { lecture: id, practice: id, 'lab:<id подгруппы>': id, … }
export function teacherFor(item, kind, subgroupId = 0) {
  const t = item.teachers ?? {};
  return t[`${kind}:${subgroupId || 0}`] ?? t[kind] ?? item.teacher_id ?? null;
}

// Единицы плана: предмет × вид занятий × подгруппа (0 — вся группа).
export function unitsOfItem(item, group) {
  const out = [];
  for (const kind of KINDS) {
    if (!item['h_' + kind]) continue;
    const sids = isSplitKind(item, kind, group?.subgroups.length) ? group.subgroups.map(s => s.id) : [0];
    for (const sid of sids) out.push({ kind, sid });
  }
  return out;
}

// Сколько пар проведено по каждой единице плана (предмет × вид × подгруппа):
// часы, внесённые вручную как «уже проведено» (done_*), плюс пары из расписания.
// Из расписания учитываются утверждённые дни; extraDate добавляет черновик этого дня, allDrafts — все черновики.
export function computeProgress(data, extraDate = null, { allDrafts = false } = {}) {
  const hpp = settingsOf(data).hours_per_pair;
  const groups = new Map(data.groups.map(g => [g.id, g]));
  const out = {};
  for (const item of data.curriculum) {
    for (const { kind, sid } of unitsOfItem(item, groups.get(item.group_id))) {
      const done = (item['done_' + kind] ?? 0) / hpp;
      if (done) out[unitKey(item.id, kind, sid)] = done;
    }
  }
  for (const l of data.lessons) {
    if (l.status !== 'active') continue;
    if (!allDrafts && data.days[l.date]?.status !== 'approved' && l.date !== extraDate) continue;
    const k = unitKey(l.curriculum_id, l.kind, l.subgroup_id);
    out[k] = (out[k] ?? 0) + 1;
  }
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

const byId = list => new Map(list.map(x => [x.id, x]));

export function validateDay(data, date) {
  const s = settingsOf(data);
  const issues = [];
  const add = (level, text, lessons = [], groupId = null) =>
    issues.push({ level, text, lessonIds: lessons.map(l => l.id), groupId });

  const lessons = data.lessons.filter(l => l.date === date && l.status === 'active');
  if (!lessons.length) return issues;

  const teachers = byId(data.teachers);
  const rooms = byId(data.rooms);
  const groups = byId(data.groups);
  const subgroups = new Map(data.groups.flatMap(g => g.subgroups.map(sg => [sg.id, sg])));
  const curriculum = byId(data.curriculum);
  const subjects = byId(data.subjects);

  const wd = weekdayOf(date);
  const roomOwners = new Map();
  for (const t of data.teachers) {
    if (t.room_id) roomOwners.set(t.room_id, [...(roomOwners.get(t.room_id) ?? []), t.id]);
  }

  const tName = id => teachers.get(id)?.short_name ?? '—';
  const who = l => {
    const sg = l.subgroup_id ? subgroups.get(l.subgroup_id) : null;
    return (groups.get(l.group_id)?.name ?? '?') + (sg ? ` (${sg.name})` : '');
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
      const a = t.availability.find(x => x.weekday === wd);
      if (!a) add('error', `${where}: ${t.short_name} не работает в этот день недели`, [l]);
      else if (l.pair < a.pair_from || l.pair > a.pair_to) {
        add('error', `${where}: ${t.short_name} доступен только с ${a.pair_from} по ${a.pair_to} пару`, [l]);
      }
      if (t.absences.some(x => x.date_from <= date && x.date_to >= date)) {
        add('error', `${where}: ${t.short_name} отсутствует в этот день`, [l]);
      }
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
  for (const g of data.groups) {
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
      } else if (pairs.length < s.min_pairs) {
        add('warning', `${st.name}: ${pairs.length} ${pairs.length === 1 ? 'пара' : 'пары'} за день, нужно не меньше ${s.min_pairs}`, st.ls, g.id);
      }
      if (pairs[0] > 1) add('warning', `${st.name}: пары начинаются с ${pairs[0]}-й, а не с 1-й`, st.ls, g.id);
      const gaps = [];
      for (let p = pairs[0]; p <= pairs[pairs.length - 1]; p++) if (!pairs.includes(p)) gaps.push(p);
      if (gaps.length) {
        add('error', `${st.name}: окно на ${gaps.join(', ')}-й паре — пары должны идти подряд`, st.ls, g.id);
      }
    }
  }

  // Один предмет у группы/подгруппы в день — не больше max_same_subject раз (лекция и практика — тоже один предмет)
  for (const g of data.groups) {
    const streams = g.subgroups.length ? g.subgroups.map(sg => ({ sid: sg.id, name: `${g.name} (${sg.name})` })) : [{ sid: 0, name: g.name }];
    for (const st of streams) {
      const ls = lessons.filter(l => l.group_id === g.id && (!l.subgroup_id || !st.sid || l.subgroup_id === st.sid));
      for (const same of groupBy(ls, l => curriculum.get(l.curriculum_id)?.subject_id).values()) {
        const pairs = new Set(same.map(l => l.pair)).size;
        if (pairs > s.max_same_subject) {
          add('error', `${st.name}: «${subjName(same[0])}» ${pairs} раза за день, можно не больше ${s.max_same_subject}`, same, g.id);
        }
      }
    }
  }

  // Преподаватель — не больше teacher_max_pairs пар в день (во всех группах вместе)
  for (const ls of groupBy(lessons, l => l.teacher_id)) {
    const pairs = new Set(ls[1].map(l => l.pair));
    if (pairs.size > s.teacher_max_pairs) {
      add('error', `${tName(ls[0])}: ${pairs.size} пар за день, допустимо не более ${s.teacher_max_pairs}`, ls[1]);
    }
  }

  // У подгрупп одной группы в один день должны быть одинаковые предметы (в любом порядке)
  for (const g of data.groups) {
    if (g.subgroups.length < 2) continue;
    const sets = g.subgroups.map(sg => lessons
      .filter(l => l.group_id === g.id && (!l.subgroup_id || l.subgroup_id === sg.id))
      .map(l => curriculum.get(l.curriculum_id)?.subject_id).sort().join(','));
    if (sets.some(x => x) && new Set(sets).size > 1) {
      add('warning', `${g.name}: у подгрупп в этот день разные предметы — обычно у них одни и те же предметы в разном порядке`, [], g.id);
    }
  }

  // Превышение часов учебного плана (с учётом этого дня)
  const progress = computeProgress(data, date);
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
