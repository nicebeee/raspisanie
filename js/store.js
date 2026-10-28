// Все действия с данными расписания. Данные — один объект (содержимое data.json),
// интерфейс обращается к нему через handle(method, path, ...) по тем же адресам, что раньше были у сервера.
import { KINDS, KIND_NAMES, computeProgress, settingsOf, teacherFor, unitKey, unitsOfItem, validateDay } from './logic.js';
import { autoSchedule, groupReadiness } from './autoschedule.js';

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const bad = msg => new StoreError(msg);

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
  rooms: { fields: { name: 'text!', building: 'text', capacity: 'int', type: 'text' } },
  subjects: { fields: { name: 'text!', short: 'text', room_type: 'text' }, unique: 'name' },
  teachers: { fields: { full_name: 'text!', short_name: 'text!', room_id: 'int', active: 'bool' } },
  groups: { fields: { name: 'text!', specialty: 'text', course: 'int', size: 'int' }, unique: 'name' },
  curriculum: {
    fields: {
      group_id: 'int!', subject_id: 'int!', teacher_id: 'int', semester: 'int',
      h_lecture: 'int', h_practice: 'int', h_lab: 'int', split_practice: 'bool', split_lab: 'bool',
      done_lecture: 'int', done_practice: 'int', done_lab: 'int',
    },
  },
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
    if (v === null && (f.startsWith('h_') || f.startsWith('done_'))) v = 0;
    out[f] = v;
  }
  return out;
}

export function emptyData() {
  return { format: 1, settings: {}, rooms: [], teachers: [], groups: [], subjects: [], curriculum: [], days: {}, lessons: [], log: [], next_id: 1 };
}

export function createStore(data) {
  const nextId = () => data.next_id++;
  const find = (list, id) => list.find(x => x.id === Number(id));
  const log = (date, action, details) => {
    data.log.unshift({ at: new Date().toISOString(), date, action, details });
    data.log.length = Math.min(data.log.length, 300);
  };
  const lessonsOn = date => data.lessons.filter(l => l.date === date);
  const removeLessons = pred => { data.lessons = data.lessons.filter(l => !pred(l)); };

  const routes = [];
  // По умолчанию действие только для администратора; { public: true } — доступно всем.
  const on = (method, pattern, fn, opts = {}) =>
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, public: !!opts.public });

  // ---------- Справочники ----------

  on('GET', '/bootstrap', () => ({
    settings: settingsOf(data),
    rooms: [...data.rooms].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true })),
    teachers: [...data.teachers].sort((a, b) => a.short_name.localeCompare(b.short_name, 'ru')),
    groups: [...data.groups].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    subjects: [...data.subjects].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    curriculum: data.curriculum,
    progress: computeProgress(data),
  }), { public: true });

  const list = name => data[name];

  function checkUnique(name, def, row, id) {
    if (!def.unique) return;
    const v = row[def.unique].toLowerCase();
    if (list(name).some(x => x.id !== id && x[def.unique].toLowerCase() === v)) throw bad('Запись с таким названием уже есть');
  }
  function checkRefs(name, row) {
    if (name === 'teachers' && row.room_id && !find(data.rooms, row.room_id)) throw bad('Аудитория не найдена');
    if (name === 'curriculum') {
      if (!find(data.groups, row.group_id)) throw bad('Группа не найдена');
      if (!find(data.subjects, row.subject_id)) throw bad('Предмет не найден');
      if (row.teacher_id && !find(data.teachers, row.teacher_id)) throw bad('Преподаватель не найден');
    }
  }

  const afterSave = {
    teachers(t, body) {
      t.availability ??= [];
      t.absences ??= [];
      if (!Array.isArray(body.availability)) return;
      const s = settingsOf(data);
      t.availability = body.availability.map(a => {
        const wd = Number(a.weekday), from = Number(a.pair_from), to = Number(a.pair_to);
        if (!(wd >= 1 && wd <= 6) || !(from >= 1 && to <= s.pairs_per_day && from <= to)) {
          throw bad('Доступность: пары указаны неверно (должно быть «с» ≤ «по»)');
        }
        return { weekday: wd, pair_from: from, pair_to: to };
      }).sort((a, b) => a.weekday - b.weekday);
    },
    // Отдельные преподаватели для видов занятий и подгрупп; совпадающие с основным не храним.
    curriculum(item, body) {
      if (body.teachers === undefined) return;
      const next = {};
      for (const [key, value] of Object.entries(body.teachers ?? {})) {
        if (!/^(lecture|practice|lab)(:\d+)?$/.test(key)) continue;
        const tid = value ? Number(value) : null;
        if (!tid || tid === item.teacher_id) continue;
        if (!find(data.teachers, tid)) throw bad('Преподаватель не найден');
        next[key] = tid;
      }
      item.teachers = next;
    },
    groups(g, body) {
      g.subgroups ??= [];
      if (!Array.isArray(body.subgroups)) return;
      const next = body.subgroups.map(sg => {
        const name = String(sg.name ?? '').trim();
        if (!name) throw bad('Укажите название подгруппы');
        const old = sg.id && g.subgroups.find(x => x.id === Number(sg.id));
        return old ? { ...old, name } : { id: nextId(), name };
      });
      const keep = new Set(next.map(x => x.id));
      const removed = g.subgroups.filter(x => !keep.has(x.id)).map(x => x.id);
      removeLessons(l => removed.includes(l.subgroup_id));
      g.subgroups = next;
    },
  };

  // Удаление с «каскадом», как раньше делала база.
  const onDelete = {
    rooms(id) {
      for (const t of data.teachers) if (t.room_id === id) t.room_id = null;
      for (const l of data.lessons) if (l.room_id === id) l.room_id = null;
    },
    teachers(id) {
      for (const c of data.curriculum) {
        if (c.teacher_id === id) c.teacher_id = null;
        for (const [k, v] of Object.entries(c.teachers ?? {})) if (v === id) delete c.teachers[k];
      }
      for (const l of data.lessons) if (l.teacher_id === id) l.teacher_id = null;
    },
    // Группа удаляется целиком: её план, расписание и предметы, которые больше нигде не нужны.
    groups(id) {
      const used = new Set(data.curriculum.filter(c => c.group_id === id).map(c => c.subject_id));
      data.curriculum = data.curriculum.filter(c => c.group_id !== id);
      removeLessons(l => l.group_id === id);
      dropUnusedSubjects(used);
    },
    subjects(id) {
      const gone = new Set(data.curriculum.filter(c => c.subject_id === id).map(c => c.id));
      data.curriculum = data.curriculum.filter(c => c.subject_id !== id);
      removeLessons(l => gone.has(l.curriculum_id));
    },
    curriculum(id, item) {
      removeLessons(l => l.curriculum_id === id);
      dropUnusedSubjects([item.subject_id]);
    },
  };

  // Предмет живёт, пока он есть в плане хотя бы одной группы.
  function dropUnusedSubjects(ids) {
    const still = new Set(data.curriculum.map(c => c.subject_id));
    const gone = new Set([...ids].filter(id => !still.has(id)));
    if (gone.size) data.subjects = data.subjects.filter(s => !gone.has(s.id));
  }

  for (const [name, def] of Object.entries(TABLES)) {
    on('POST', `/${name}`, (_, body) => {
      const row = clean(def, body);
      checkUnique(name, def, row, null);
      checkRefs(name, row);
      const item = { id: nextId(), ...row };
      afterSave[name]?.(item, body);
      list(name).push(item);
      return { id: item.id };
    });
    on('PUT', `/${name}/:id`, ({ id }, body) => {
      const item = find(list(name), id);
      if (!item) throw new StoreError('Запись не найдена', 404);
      const row = clean(def, body);
      checkUnique(name, def, row, item.id);
      checkRefs(name, row);
      const draft = { ...item, ...row };
      afterSave[name]?.(draft, body);
      Object.assign(item, draft);
      return { id: item.id };
    });
    on('DELETE', `/${name}/:id`, ({ id }) => {
      const i = list(name).findIndex(x => x.id === Number(id));
      if (i >= 0) {
        const [item] = list(name).splice(i, 1);
        onDelete[name](Number(id), item);
      }
      return { ok: true };
    });
  }

  // Добавить предмет в группу: предмет с таким названием переиспользуется, иначе создаётся.
  // В план группы он попадает без часов — их задают во вкладке «Учебный план».
  on('POST', '/groups/:id/subjects', ({ id }, body) => {
    const group = find(data.groups, id);
    if (!group) throw bad('Группа не найдена');
    const row = clean(TABLES.subjects, body);
    let subj = data.subjects.find(s => s.name.toLowerCase() === row.name.toLowerCase());
    if (!subj) {
      subj = { id: nextId(), ...row };
      data.subjects.push(subj);
    } else if (row.room_type) {
      subj.room_type = row.room_type;
    }
    if (data.curriculum.some(c => c.group_id === group.id && c.subject_id === subj.id)) {
      throw bad(`«${subj.name}» уже есть у группы ${group.name}`);
    }
    // Можно сразу передать часы, преподавателя и т.п. — как у строки учебного плана.
    const plan = clean(TABLES.curriculum, { semester: null, ...body.plan, group_id: group.id, subject_id: subj.id });
    checkRefs('curriculum', plan);
    const item = { id: nextId(), ...plan };
    afterSave.curriculum(item, body.plan ?? {});
    data.curriculum.push(item);
    return { id: subj.id };
  });

  // Отсутствия хранятся без причины: файл данных публичный.
  on('POST', '/absences', (_, body) => {
    const t = find(data.teachers, body.teacher_id);
    if (!t) throw bad('Преподаватель не найден');
    const from = checkDate(body.date_from), to = checkDate(body.date_to);
    if (to < from) throw bad('Дата окончания раньше даты начала');
    const a = { id: nextId(), date_from: from, date_to: to };
    t.absences.push(a);
    t.absences.sort((x, y) => y.date_from.localeCompare(x.date_from));
    return { id: a.id };
  });
  on('DELETE', '/absences/:id', ({ id }) => {
    for (const t of data.teachers) t.absences = t.absences.filter(a => a.id !== Number(id));
    return { ok: true };
  });

  on('POST', '/curriculum/copy', (_, body) => {
    const from = Number(body.from_group), to = Number(body.to_group);
    if (!find(data.groups, to)) throw bad('Группа не найдена');
    if (from === to) throw bad('Выберите другую группу');
    const items = data.curriculum.filter(c => c.group_id === from);
    for (const c of items) data.curriculum.push({ ...c, id: nextId(), group_id: to });
    return { copied: items.length };
  });

  // Загрузка учебного плана из Excel (разбор — в plan-import.js).
  // Предметы ищутся по названию и создаются, если их нет; у уже существующих строк плана
  // обновляются только часы и семестр — преподаватель и деление на подгруппы сохраняются.
  on('POST', '/curriculum/import', (_, body) => {
    let group;
    if (body.new_group) {
      const g = clean(TABLES.groups, body.new_group);
      checkUnique('groups', TABLES.groups, g, null);
      group = { id: nextId(), ...g, subgroups: [] };
      data.groups.push(group);
    } else {
      group = find(data.groups, body.group_id);
      if (!group) throw bad('Выберите группу');
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw bad('Не выбрано ни одного предмета');

    const hours = v => {
      const n = Number(v ?? 0);
      if (!Number.isInteger(n) || n < 0) throw bad('Часы должны быть целым неотрицательным числом');
      return n;
    };
    let created = 0, updated = 0, subjectsCreated = 0;
    for (const it of items) {
      const name = String(it.name ?? '').replace(/\s+/g, ' ').trim();
      if (!name) throw bad('У предмета нет названия');
      let subj = data.subjects.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!subj) {
        subj = { id: nextId(), name, room_type: '' };
        data.subjects.push(subj);
        subjectsCreated++;
      }
      const row = {
        h_lecture: hours(it.lecture), h_practice: hours(it.practice), h_lab: hours(it.lab),
        semester: it.semester === 1 || it.semester === 2 ? it.semester : null,
      };
      const existing = data.curriculum.find(c => c.group_id === group.id && c.subject_id === subj.id);
      if (existing) {
        Object.assign(existing, row);
        updated++;
      } else {
        data.curriculum.push({ id: nextId(), group_id: group.id, subject_id: subj.id, teacher_id: null, split_practice: 0, split_lab: 0, ...row });
        created++;
      }
    }
    log(null, 'Загрузка плана', `${group.name}: добавлено предметов ${created}, обновлено ${updated}` + (body.source ? ` (файл ${body.source})` : ''));
    return { group_id: group.id, created, updated, subjects_created: subjectsCreated };
  });

  on('PUT', '/settings', (_, body) => {
    const s = settingsOf(data);
    const minPairs = Number(body.min_pairs ?? s.min_pairs);
    const maxPairs = Number(body.max_pairs ?? s.max_pairs);
    if (!(Number.isInteger(minPairs) && minPairs >= 1 && minPairs <= maxPairs)) throw bad('Минимум пар — от 1 и не больше максимума');
    const studyDays = Number(body.study_days ?? s.study_days);
    if (![5, 6].includes(studyDays)) throw bad('Учебных дней в неделе — 5 или 6');
    const sem1 = body.semester1_end === undefined ? s.semester1_end : (body.semester1_end || null);
    const sem2 = body.semester2_end === undefined ? s.semester2_end : (body.semester2_end || null);
    for (const d of [sem1, sem2]) if (d) checkDate(d);
    if (sem1 && sem2 && sem2 <= sem1) throw bad('Конец 2-го семестра должен быть позже конца 1-го');
    const teacherMax = Number(body.teacher_max_pairs ?? s.teacher_max_pairs);
    if (!(Number.isInteger(teacherMax) && teacherMax >= 1 && teacherMax <= s.pairs_per_day)) throw bad(`Пар у преподавателя в день — от 1 до ${s.pairs_per_day}`);
    const hpp = Number(body.hours_per_pair ?? s.hours_per_pair);
    const bells = body.bells ?? s.bells;
    if (!(Number.isInteger(maxPairs) && maxPairs >= 1 && maxPairs <= s.pairs_per_day)) throw bad(`Лимит пар — от 1 до ${s.pairs_per_day}`);
    if (!(Number.isInteger(hpp) && hpp >= 1 && hpp <= 4)) throw bad('Часов в паре — от 1 до 4');
    if (!Array.isArray(bells) || bells.length !== s.pairs_per_day ||
        bells.some(b => !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end))) {
      throw bad('Сетка звонков заполнена неверно');
    }
    data.settings = { ...data.settings, min_pairs: minPairs, max_pairs: maxPairs, teacher_max_pairs: teacherMax, study_days: studyDays, semester1_end: sem1, semester2_end: sem2, hours_per_pair: hpp, bells: bells.map((b, i) => ({ pair: i + 1, start: b.start, end: b.end })) };
    return settingsOf(data);
  });

  // ---------- Расписание на день ----------

  const ensureDay = date => { data.days[date] ??= { status: 'draft', approved_at: null }; };
  const dayStatus = date => data.days[date]?.status ?? 'draft';

  function dayPayload(date) {
    const day = data.days[date];
    return {
      date,
      status: day?.status ?? 'draft',
      approved_at: day?.approved_at ?? null,
      lessons: lessonsOn(date).sort((a, b) => a.pair - b.pair || (a.subgroup_id ?? 0) - (b.subgroup_id ?? 0)),
      issues: validateDay(data, date),
      progress: computeProgress(data, date),
    };
  }

  on('GET', '/day/:date', ({ date }) => dayPayload(checkDate(date)));

  // Полностью заменяет занятия группы в одной паре (вся группа или по подгруппам).
  on('PUT', '/day/:date/cell', ({ date }, body) => {
    checkDate(date);
    const s = settingsOf(data);
    const group = find(data.groups, body.group_id);
    if (!group) throw bad('Группа не найдена');
    const pair = Number(body.pair);
    if (!(Number.isInteger(pair) && pair >= 1 && pair <= s.pairs_per_day)) throw bad('Неверный номер пары');
    const subIds = new Set(group.subgroups.map(x => x.id));

    const list = (body.lessons ?? []).map(x => {
      const item = find(data.curriculum, x.curriculum_id);
      if (!item || item.group_id !== group.id) throw bad('Предмет не найден в учебном плане группы');
      if (!KINDS.includes(x.kind)) throw bad('Выберите вид занятия');
      if (!item['h_' + x.kind]) throw bad('В плане нет часов этого вида занятий');
      const sid = x.subgroup_id ? Number(x.subgroup_id) : null;
      if (sid !== null && !subIds.has(sid)) throw bad('Подгруппа не найдена');
      const teacherId = x.teacher_id ? Number(x.teacher_id) : teacherFor(item, x.kind, x.subgroup_id);
      const teacher = teacherId ? find(data.teachers, teacherId) : null;
      if (teacherId && !teacher) throw bad('Преподаватель не найден');
      // Преподаватель с закреплённой аудиторией всегда ведёт занятия в ней.
      const roomId = teacher?.room_id ?? (x.room_id ? Number(x.room_id) : null);
      return { sid, cid: item.id, kind: x.kind, teacherId: teacherId ?? null, roomId };
    });
    if (new Set(list.map(l => l.sid ?? 0)).size !== list.length) throw bad('Два занятия для одной подгруппы в одной паре');
    if (list.some(l => l.sid === null) && list.length > 1) throw bad('Общая пара группы не может идти одновременно с парой подгруппы');

    ensureDay(date);
    const inCell = l => l.date === date && l.group_id === group.id && l.pair === pair && l.status === 'active';
    const before = data.lessons.filter(inCell).length;
    removeLessons(inCell);
    for (const l of list) {
      data.lessons.push({
        id: nextId(), date, pair, group_id: group.id, subgroup_id: l.sid, curriculum_id: l.cid,
        kind: l.kind, teacher_id: l.teacherId, room_id: l.roomId, status: 'active',
      });
    }
    log(date, 'Изменение пары', `${group.name}, ${pair}-я пара: было занятий ${before}, стало ${list.length}` +
      (dayStatus(date) === 'approved' ? ' (в утверждённом расписании)' : ''));
    return dayPayload(date);
  });

  // Перенос пары группы на другую пару того же дня (обмен местами).
  on('POST', '/day/:date/move', ({ date }, body) => {
    checkDate(date);
    const s = settingsOf(data);
    const gid = Number(body.group_id), from = Number(body.from), to = Number(body.to);
    const ok = p => Number.isInteger(p) && p >= 1 && p <= s.pairs_per_day;
    if (!ok(from) || !ok(to) || from === to) throw bad('Неверный номер пары');
    const group = find(data.groups, gid);
    if (!group) throw bad('Группа не найдена');
    for (const l of data.lessons) {
      if (l.date !== date || l.group_id !== gid || l.status !== 'active') continue;
      if (l.pair === from) l.pair = to;
      else if (l.pair === to) l.pair = from;
    }
    log(date, 'Перенос пары', `${group.name}: ${from}-я ↔ ${to}-я пара`);
    return dayPayload(date);
  });

  function setLessonStatus(id, status) {
    const l = find(data.lessons, id);
    if (!l) throw new StoreError('Занятие не найдено', 404);
    if (status === 'active') {
      const clash = data.lessons.some(x => x !== l && x.date === l.date && x.group_id === l.group_id && x.pair === l.pair &&
        x.status === 'active' && (!x.subgroup_id || !l.subgroup_id || x.subgroup_id === l.subgroup_id));
      if (clash) throw bad('На этой паре уже стоит другое занятие — сначала уберите его');
    }
    l.status = status;
    log(l.date, status === 'cancelled' ? 'Отмена пары' : 'Возврат пары', `${find(data.groups, l.group_id)?.name}, ${l.pair}-я пара`);
    return dayPayload(l.date);
  }
  on('POST', '/lessons/:id/cancel', ({ id }) => setLessonStatus(id, 'cancelled'));
  on('POST', '/lessons/:id/restore', ({ id }) => setLessonStatus(id, 'active'));

  on('POST', '/day/:date/approve', ({ date }) => {
    checkDate(date);
    if (!lessonsOn(date).some(l => l.status === 'active')) throw bad('В расписании нет ни одной пары');
    const errors = validateDay(data, date).filter(i => i.level === 'error');
    if (errors.length) throw bad(`Нельзя утвердить: в расписании ошибок — ${errors.length}`);
    ensureDay(date);
    data.days[date] = { status: 'approved', approved_at: new Date().toISOString() };
    log(date, 'Утверждение', `Расписание на ${fmtDate(date)} утверждено`);
    return dayPayload(date);
  });

  on('POST', '/day/:date/unapprove', ({ date }) => {
    checkDate(date);
    ensureDay(date);
    data.days[date] = { status: 'draft', approved_at: null };
    log(date, 'Возврат в черновик', `Расписание на ${fmtDate(date)} снова черновик`);
    return dayPayload(date);
  });

  on('POST', '/day/:date/copy', ({ date }, body) => {
    checkDate(date);
    const from = checkDate(body.from ?? shiftDate(date, -7));
    if (dayStatus(date) === 'approved') throw bad('Расписание утверждено — сначала верните его в черновик');
    if (lessonsOn(date).some(l => l.status === 'active')) throw bad('Сначала очистите расписание на этот день');
    const src = lessonsOn(from).filter(l => l.status === 'active');
    if (!src.length) throw bad(`На ${fmtDate(from)} расписания нет`);
    ensureDay(date);
    for (const l of src) data.lessons.push({ ...l, id: nextId(), date });
    log(date, 'Копирование', `Скопировано ${src.length} занятий с ${fmtDate(from)}`);
    return dayPayload(date);
  });

  on('DELETE', '/day/:date', ({ date }) => {
    checkDate(date);
    if (dayStatus(date) === 'approved') throw bad('Расписание утверждено — сначала верните его в черновик');
    removeLessons(l => l.date === date);
    log(date, 'Очистка', `Расписание на ${fmtDate(date)} очищено`);
    return dayPayload(date);
  });

  // ---------- Автосоставление ----------

  // Готовность групп: у предметов с оставшимися часами должны быть преподаватели.
  on('GET', '/auto/check', () => data.groups.map(g => ({ group_id: g.id, ...groupReadiness(data, g.id) })));

  on('POST', '/auto', (_, body) => {
    const dates = (Array.isArray(body.dates) ? body.dates : []).map(checkDate);
    const groupIds = (Array.isArray(body.group_ids) ? body.group_ids : []).map(Number);
    if (!dates.length) throw bad('Не выбраны дни');
    if (!groupIds.length) throw bad('Не выбраны группы');
    const notReady = groupIds.map(id => find(data.groups, id)).filter(g => g && groupReadiness(data, g.id).missing.length);
    if (notReady.length) throw bad(`Сначала укажите преподавателей у предметов групп: ${notReady.map(g => g.name).join(', ')}`);
    const r = autoSchedule(data, {
      dates, groupIds, minPairs: Number(body.min_pairs) || undefined, maxPairs: Number(body.max_pairs) || undefined,
      maxSameSubject: Number(body.max_same) || undefined,
    });
    for (const l of r.lessons) {
      ensureDay(l.date);
      data.lessons.push({ id: nextId(), ...l });
    }
    if (r.lessons.length) log(dates.length === 1 ? dates[0] : null, 'Автосоставление', `Поставлено пар: ${r.lessons.length} (${dates.map(fmtDate).join(', ')})`);
    return { created: r.lessons.length, report: r.report };
  });

  // ---------- Просмотр и отчёты ----------

  on('GET', '/view', (_, __, qs, ctx) => {
    const from = checkDate(qs.get('from')), to = checkDate(qs.get('to'));
    const col = { group: 'group_id', teacher: 'teacher_id', room: 'room_id' }[qs.get('type')];
    if (!col) throw bad('Неверный тип просмотра');
    const drafts = ctx.admin && qs.get('drafts') === '1';
    const id = Number(qs.get('id'));
    return {
      lessons: data.lessons
        .filter(l => l.date >= from && l.date <= to && l[col] === id && (drafts || dayStatus(l.date) === 'approved'))
        .map(l => ({ ...l, day_status: dayStatus(l.date) }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.pair - b.pair),
    };
  }, { public: true });

  // Нагрузка: по каждому преподавателю — его предметы (группа × вид занятий × подгруппа) с часами.
  // «Проведено» — внесённые вручную часы и утверждённые пары; «за месяц» — по фактическим парам преподавателя.
  on('GET', '/report/teachers', () => {
    const s = settingsOf(data);
    const hpp = s.hours_per_pair;
    const progress = computeProgress(data);
    const groups = new Map(data.groups.map(g => [g.id, g]));
    const items = new Map(data.teachers.map(t => [t.id, []]));
    for (const c of data.curriculum) {
      const g = groups.get(c.group_id);
      for (const { kind, sid } of unitsOfItem(c, g)) {
        const tid = teacherFor(c, kind, sid);
        if (!items.has(tid)) continue;
        items.get(tid).push({
          group: g?.name ?? '?',
          subject: find(data.subjects, c.subject_id)?.name ?? '?',
          kind: KIND_NAMES[kind],
          subgroup: sid ? g.subgroups.find(x => x.id === sid)?.name ?? '' : '',
          planned_h: c['h_' + kind],
          done_h: Math.round((progress[unitKey(c.id, kind, sid)] ?? 0) * hpp),
        });
      }
    }
    const monthStart = new Date().toISOString().slice(0, 8) + '01';
    const month = new Map();
    for (const l of data.lessons) {
      if (l.status !== 'active' || dayStatus(l.date) !== 'approved' || !l.teacher_id || l.date < monthStart) continue;
      month.set(l.teacher_id, (month.get(l.teacher_id) ?? 0) + 1);
    }
    return {
      hours_per_pair: hpp,
      rows: [...data.teachers].sort((a, b) => a.short_name.localeCompare(b.short_name, 'ru')).map(t => {
        const list = items.get(t.id).sort((a, b) => a.group.localeCompare(b.group, 'ru', { numeric: true }) || a.subject.localeCompare(b.subject, 'ru'));
        return {
          id: t.id,
          name: t.short_name,
          planned_h: list.reduce((x, i) => x + i.planned_h, 0),
          done_h: list.reduce((x, i) => x + i.done_h, 0),
          month_h: (month.get(t.id) ?? 0) * hpp,
          items: list,
        };
      }),
    };
  });

  on('GET', '/log', () => data.log.slice(0, 200));

  return {
    data,
    // Убирает предметы, которых нет ни в одном учебном плане (остались от старых удалений). Возвращает, сколько убрано.
    pruneUnusedSubjects() {
      const before = data.subjects.length;
      dropUnusedSubjects(data.subjects.map(s => s.id));
      return before - data.subjects.length;
    },
    handle(method, path, query, body, ctx = { admin: false }) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        if (!r.public && !ctx.admin) throw new StoreError('Войдите как администратор', 401);
        return r.fn({ ...m.groups }, body ?? {}, query ?? new URLSearchParams(), ctx);
      }
      throw new StoreError('Не найдено', 404);
    },
  };
}
