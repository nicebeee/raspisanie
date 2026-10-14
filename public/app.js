'use strict';

const KINDS = ['lecture', 'practice', 'lab'];
const KIND_NAMES = { lecture: 'Лекция', practice: 'Практическое', lab: 'Лабораторная' };
const KIND_SHORT = { lecture: 'лек.', practice: 'пр.', lab: 'лаб.' };
const KIND_COL = { lecture: 'Лекции, ч', practice: 'Практические, ч', lab: 'Лабораторные, ч' };
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const ROOM_TYPES = ['Лекционная', 'Компьютерный класс', 'Лаборатория', 'Мастерская', 'Спортзал'];

const TABS = [
  ['day', 'Расписание на день'],
  ['view', 'Просмотр'],
  ['plan', 'Учебный план'],
  ['teachers', 'Преподаватели'],
  ['rooms', 'Аудитории'],
  ['groups', 'Группы и предметы'],
  ['report', 'Нагрузка'],
  ['settings', 'Настройки'],
];

let ref = null; // справочники с сервера
const state = {
  admin: false,
  tab: location.hash.slice(1) || store('tab') || 'day',
  date: nextStudyDay(todayISO()),
  day: null,
  planGroup: Number(store('planGroup')) || null,
  planSemester: 0,
  view: { type: store('viewType') || 'group', id: Number(store('viewId')) || null, week: null, drafts: false },
};

// ---------- Утилиты ----------

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('rasp.' + key);
    localStorage.setItem('rasp.' + key, String(value));
  } catch { return null; }
}

const $ = sel => document.querySelector(sel);

// replaceChildren, пропускающий пустые значения (null, false).
function mount(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
}

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value' || typeof v === 'boolean') node[k] = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function select(options, value, onchange, props = {}) {
  return el('select', { ...props, onchange: e => onchange?.(e.target.value) },
    options.map(([v, label, disabled]) => el('option', { value: String(v), selected: String(v) === String(value ?? ''), disabled: !!disabled }, label)));
}

const field = (label, input, hint) =>
  el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('span', { class: 'hint' }, hint) : null);

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const fmtNum = n => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.admin && !path.startsWith('/login')) {
    // Сессия истекла — возвращаемся в гостевой режим.
    state.admin = false;
    await reload();
    render();
  }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const item = el('div', { class: 'toast-item ' + kind }, msg);
  $('#toast').append(item);
  setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3000);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    throw e;
  }
}
const quiet = fn => guard(fn).catch(() => {});

// Даты: работаем с локальной датой в формате ГГГГ-ММ-ДД
function pad(n) { return String(n).padStart(2, '0'); }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayISO() { return iso(new Date()); }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); }
function weekday(s) { const w = parseISO(s).getDay(); return w === 0 ? 7 : w; }
function mondayOf(s) { return addDays(s, 1 - weekday(s)); }
function nextStudyDay(s) { return weekday(s) === 7 ? addDays(s, 1) : s; }
const fmtDate = s => parseISO(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = s => s.split('-').reverse().slice(0, 2).join('.');

// ---------- Справочники ----------

async function reload() {
  ref = await api('GET', state.admin ? '/bootstrap' : '/public/bootstrap');
  ref.byId = {};
  for (const k of ['rooms', 'teachers', 'groups', 'subjects', 'curriculum']) {
    ref.byId[k] = new Map(ref[k].map(x => [x.id, x]));
  }
  ref.subgroups = new Map(ref.groups.flatMap(g => g.subgroups.map(s => [s.id, { ...s, group: g }])));
}
const room = id => ref.byId.rooms.get(id);
const teacher = id => ref.byId.teachers.get(id);
const group = id => ref.byId.groups.get(id);
const subject = id => ref.byId.subjects.get(id);
const planItem = id => ref.byId.curriculum.get(id);
const subjName = item => subject(item?.subject_id)?.name ?? '?';

function subShort(sg) {
  const m = sg.name.match(/\d+/);
  return m ? 'П' + m[0] : sg.name.slice(0, 3);
}

// Вид занятия идёт по подгруппам, если у группы есть подгруппы и в плане отмечено деление.
function isSplit(item, kind) {
  const g = group(item.group_id);
  return !!(g?.subgroups.length && ((kind === 'practice' && item.split_practice) || (kind === 'lab' && item.split_lab)));
}
const plannedPairs = (item, kind) => item['h_' + kind] / ref.settings.hours_per_pair;
const unitsOf = (item, kind) => (isSplit(item, kind)
  ? group(item.group_id).subgroups.map(s => ({ sid: s.id, label: subShort(s) }))
  : [{ sid: 0, label: '' }]);
const doneOf = (progress, item, kind, sid) => progress[`${item.id}|${kind}|${sid || 0}`] || 0;

// Сводка по строке плана. «Осталось» считается по самой отстающей подгруппе.
function itemStats(item, progress) {
  let planned = 0, done = 0, left = 0, over = false;
  const parts = [];
  for (const k of KINDS) {
    if (!item['h_' + k]) continue;
    const p = plannedPairs(item, k);
    const units = unitsOf(item, k);
    const ds = units.map(u => doneOf(progress, item, k, u.sid));
    if (ds.some(d => d > p)) over = true;
    const minDone = Math.min(...ds);
    planned += p;
    done += Math.min(minDone, p);
    left += Math.max(0, p - minDone);
    const detail = units.length > 1
      ? units.map((u, i) => `${u.label} ${ds[i]}/${fmtNum(p)}`).join(', ')
      : `${ds[0]}/${fmtNum(p)}`;
    parts.push(`${KIND_SHORT[k]} ${detail}`);
  }
  return { planned, done, left, over, parts };
}

function availabilityText(t) {
  if (!t.availability.length) return 'не указана';
  return t.availability.map(a => `${DAY_SHORT[a.weekday - 1]} ${a.pair_from}–${a.pair_to}`).join(', ');
}

// ---------- Каркас ----------

function renderTabs() {
  mount($('#account'), state.admin
    ? [el('span', { class: 'muted small' }, 'Администратор'), el('button', { class: 'btn', onclick: logout }, 'Выйти')]
    : el('button', { class: 'btn', onclick: openLogin }, 'Войти'));
  // Гости видят только расписание, без вкладок.
  if (!state.admin) return mount($('#tabs'));
  mount($('#tabs'), TABS.map(([id, label]) =>
    el('button', { class: state.tab === id ? 'active' : '', onclick: () => { state.tab = id; store('tab', id); history.replaceState(null, '', '#' + id); render(); } }, label)));
}

function openLogin() {
  let password = '';
  const submit = close => quiet(async () => {
    await api('POST', '/login', { password });
    state.admin = true;
    state.tab = store('tab') || 'day';
    await reload();
    close();
    render();
  });
  const closeLogin = modal('Вход для администратора', [
    el('form', { onsubmit: e => { e.preventDefault(); submit(closeLogin); } },
      field('Пароль', el('input', { type: 'password', autocomplete: 'current-password', oninput: e => { password = e.target.value; } }))),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', { class: 'btn primary', onclick: () => submit(close) }, 'Войти'),
  ]);
}

async function logout() {
  await quiet(async () => {
    await api('POST', '/logout', {});
    state.admin = false;
    history.replaceState(null, '', location.pathname);
    await reload();
    render();
  });
}

const VIEWS = {
  day: renderDay, view: renderView, plan: renderPlan, teachers: renderTeachers,
  rooms: renderRooms, groups: renderGroups, report: renderReport, settings: renderSettings,
};

async function render() {
  if (!state.admin) state.tab = 'view';
  else if (!VIEWS[state.tab]) state.tab = 'day';
  renderTabs();
  const main = $('#main');
  try {
    await VIEWS[state.tab](main);
  } catch (e) {
    mount(main, el('div', { class: 'card' }, 'Не удалось загрузить данные: ' + e.message));
  }
}

function modal(title, body, actions, opts = {}) {
  const root = $('#modal-root');
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { mount(root); document.removeEventListener('keydown', onKey); }
  document.addEventListener('keydown', onKey);
  const box = el('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'modal-head' }, el('h3', {}, title), el('button', { class: 'btn icon ghost', onclick: close, 'aria-label': 'Закрыть' }, '×')),
    el('div', { class: 'modal-body' }, body),
    el('div', { class: 'modal-foot' }, actions(close)));
  mount(root, el('div', { class: 'backdrop', onmousedown: e => { if (e.target === e.currentTarget) close(); } }, box));
  box.querySelector('input, select')?.focus();
  return close;
}

// ---------- Расписание на день ----------

async function renderDay(main) {
  state.day = await api('GET', `/day/${state.date}`);
  drawDay(main);
}

function drawDay(main = $('#main')) {
  const d = state.day;
  const wd = weekday(d.date);
  const approved = d.status === 'approved';
  const errors = d.issues.filter(i => i.level === 'error');
  const warnings = d.issues.filter(i => i.level === 'warning');
  const active = d.lessons.filter(l => l.status === 'active');

  state.lessonLevel = new Map();
  for (const i of d.issues) for (const id of i.lessonIds) {
    if (state.lessonLevel.get(id) !== 'error') state.lessonLevel.set(id, i.level);
  }
  const groupError = new Set(errors.filter(i => i.groupId).map(i => i.groupId));

  const go = n => {
    let next = addDays(state.date, n);
    if (weekday(next) === 7) next = addDays(next, n);
    state.date = next;
    render();
  };

  const toolbar = el('div', { class: 'toolbar no-print' },
    el('button', { class: 'btn icon', title: 'Предыдущий день', onclick: () => go(-1) }, '‹'),
    el('input', { type: 'date', value: d.date, onchange: e => { if (e.target.value) { state.date = e.target.value; render(); } } }),
    el('button', { class: 'btn icon', title: 'Следующий день', onclick: () => go(1) }, '›'),
    el('span', { class: 'day-name' }, DAY_FULL[wd - 1]),
    el('span', { class: 'badge ' + (approved ? 'ok' : 'draft') }, approved ? 'Утверждено' : 'Черновик'),
    el('div', { class: 'spacer' }),
    !approved && !active.length && el('button', { class: 'btn', onclick: copyPrevWeek }, 'Скопировать с прошлой недели'),
    !approved && d.lessons.length > 0 && el('button', { class: 'btn', onclick: clearDay }, 'Очистить'),
    el('button', { class: 'btn', onclick: () => window.print() }, 'Печать'),
    approved
      ? el('button', { class: 'btn', onclick: () => dayAction('unapprove') }, 'Вернуть в черновик')
      : el('button', {
        class: 'btn primary', disabled: errors.length > 0 || !active.length,
        title: errors.length ? 'Сначала исправьте ошибки' : '', onclick: () => dayAction('approve'),
      }, 'Утвердить'),
  );

  const bells = ref.settings.bells;
  const grid = el('table', { class: 'grid' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'gcol' }, 'Группа'),
      bells.map(b => el('th', {}, `${b.pair} пара`, el('div', { class: 'pair-time' }, `${b.start}–${b.end}`))))),
    el('tbody', {}, ref.groups.map(g => el('tr', {},
      el('th', { class: 'gcol' + (groupError.has(g.id) ? ' lvl-error' : '') },
        el('div', { class: 'gname' }, g.name),
        g.subgroups.length ? el('div', { class: 'muted small' }, `${g.subgroups.length} ${plural(g.subgroups.length, ['подгруппа', 'подгруппы', 'подгрупп'])}`) : null),
      bells.map(b => cellTd(g, b.pair))))));

  const issues = el('section', { class: 'card issues' },
    el('h3', {}, 'Проверка'),
    !active.length
      ? el('p', { class: 'muted' }, 'Пар пока нет. Нажмите на ячейку, чтобы поставить пару.')
      : !d.issues.length
        ? el('p', { class: 'all-good' }, 'Ошибок нет — расписание можно утверждать.')
        : el('p', { class: 'muted' },
          `${errors.length} ${plural(errors.length, ['ошибка', 'ошибки', 'ошибок'])}, ` +
          `${warnings.length} ${plural(warnings.length, ['предупреждение', 'предупреждения', 'предупреждений'])}`),
    el('ul', {}, [...errors, ...warnings].map(i => el('li', { class: 'issue ' + i.level }, i.text))),
    approved ? el('p', { class: 'hint' }, 'Расписание утверждено: пары списаны с учебного плана. Изменения и отмены сразу пересчитывают остаток.') : null,
  );

  mount(main,
    el('h2', { class: 'print-only' }, `Расписание на ${fmtDate(d.date)} (${DAY_FULL[wd - 1].toLowerCase()})`),
    toolbar,
    wd === 7 ? el('div', { class: 'notice warn no-print', style: 'margin-bottom:12px' }, 'Воскресенье — не учебный день.') : null,
    el('div', { class: 'layout-day' }, el('div', { class: 'scroll-x' }, grid), issues),
  );
}

function cellTd(g, pair) {
  const d = state.day;
  const ls = d.lessons.filter(l => l.group_id === g.id && l.pair === pair);
  const active = ls.filter(l => l.status === 'active');
  const cancelled = ls.filter(l => l.status === 'cancelled');
  const levels = active.map(l => state.lessonLevel.get(l.id));
  const level = levels.includes('error') ? 'error' : levels.includes('warning') ? 'warning' : '';

  const td = el('td', {
    class: `cell ${level ? 'lvl-' + level : ''}`,
    title: 'Нажмите, чтобы изменить. Перетащите, чтобы перенести на другую пару.',
    onclick: () => openCellEditor(g, pair),
    ondragover: e => { e.preventDefault(); td.classList.add('drop'); },
    ondragleave: () => td.classList.remove('drop'),
    ondrop: e => {
      e.preventDefault();
      td.classList.remove('drop');
      let src;
      try { src = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (src.group !== g.id) return toast('Переносить пару можно только в пределах своей группы', 'error');
      if (src.pair === pair) return;
      quiet(async () => {
        state.day = await api('POST', `/day/${d.date}/move`, { group_id: g.id, from: src.pair, to: pair });
        drawDay();
      });
    },
  });

  const whole = active.find(l => !l.subgroup_id);
  if (whole) {
    td.append(lessonBlock(whole));
  } else if (active.length) {
    for (const sg of g.subgroups) {
      const l = active.find(x => x.subgroup_id === sg.id);
      td.append(el('div', { class: 'sub-line' },
        el('span', { class: 'sub-tag' }, subShort(sg)),
        l ? lessonBlock(l) : el('span', { class: 'muted small' }, 'нет пары')));
    }
  } else if (!cancelled.length) {
    td.append(el('div', { class: 'add-hint' }, '+'));
  }
  for (const l of cancelled) td.append(el('div', { class: 'cancelled' }, lessonText(l), ' — отменена'));

  if (active.length) {
    td.draggable = true;
    td.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', JSON.stringify({ group: g.id, pair })));
  }
  return td;
}

function lessonBlock(l) {
  const t = teacher(l.teacher_id), r = room(l.room_id);
  return el('div', { class: 'lesson' },
    el('div', { class: 'l-subj' }, subjName(planItem(l.curriculum_id)), ' ', el('span', { class: 'l-kind' }, KIND_SHORT[l.kind])),
    el('div', { class: 'l-meta' }, t?.short_name ?? 'нет преподавателя', ' · ', r ? 'ауд. ' + r.name : 'нет аудитории'));
}

function lessonText(l) {
  const sg = l.subgroup_id ? ref.subgroups.get(l.subgroup_id) : null;
  return `${sg ? subShort(sg) + ': ' : ''}${subjName(planItem(l.curriculum_id))} ${KIND_SHORT[l.kind]}`;
}

async function dayAction(action) {
  await quiet(async () => {
    state.day = await api('POST', `/day/${state.date}/${action}`);
    if (action === 'approve') toast('Расписание утверждено, остаток часов пересчитан');
    await reload();
    drawDay();
  });
}

async function copyPrevWeek() {
  const from = addDays(state.date, -7);
  await quiet(async () => {
    state.day = await api('POST', `/day/${state.date}/copy`, { from });
    toast(`Скопировано расписание с ${fmtDate(from)}`);
    drawDay();
  });
}

async function clearDay() {
  if (!confirm('Удалить все пары на этот день?')) return;
  await quiet(async () => {
    state.day = await api('DELETE', `/day/${state.date}`);
    drawDay();
  });
}

// Окно редактирования одной пары группы: вся группа или по подгруппам.
function openCellEditor(g, pair) {
  const d = state.day;
  const wd = weekday(d.date);
  const bell = ref.settings.bells[pair - 1];
  const cell = d.lessons.filter(l => l.group_id === g.id && l.pair === pair);
  const existing = cell.filter(l => l.status === 'active');
  const cancelled = cell.filter(l => l.status === 'cancelled');
  const items = ref.curriculum.filter(c => c.group_id === g.id).sort((a, b) => subjName(a).localeCompare(subjName(b), 'ru'));
  const othersAtPair = d.lessons.filter(l => l.status === 'active' && l.pair === pair && l.group_id !== g.id);
  let mode = existing.some(l => l.subgroup_id) ? 'sub' : 'whole';

  const makeSlot = (sg, lesson) => {
    const s = {
      sg,
      curriculum_id: lesson?.curriculum_id ?? '',
      kind: lesson?.kind ?? '',
      teacher_id: lesson?.teacher_id ?? '',
      room_id: lesson?.room_id ?? '',
      node: el('div', { class: 'slot' }),
    };
    s.kinds = () => {
      const item = planItem(Number(s.curriculum_id));
      if (!item) return [];
      return KINDS.filter(k => item['h_' + k] > 0 && isSplit(item, k) === !!sg);
    };
    s.draw = () => drawSlot(s);
    s.read = () => (s.curriculum_id ? {
      subgroup_id: sg?.id ?? null,
      curriculum_id: Number(s.curriculum_id),
      kind: s.kind,
      teacher_id: s.teacher_id ? Number(s.teacher_id) : null,
      room_id: s.room_id ? Number(s.room_id) : null,
    } : null);
    return s;
  };

  const slots = {
    whole: [makeSlot(null, existing.find(l => !l.subgroup_id))],
    sub: g.subgroups.map(sg => makeSlot(sg, existing.find(l => l.subgroup_id === sg.id))),
  };
  const allSlots = () => [...slots.whole, ...slots.sub];

  // Кто занят на этой паре: другие группы и другие подгруппы этой же ячейки.
  function busy(kind, id, self) {
    const who = othersAtPair.filter(l => l[kind] === id).map(l => group(l.group_id)?.name);
    for (const s of slots[mode]) {
      if (s !== self && s.curriculum_id && Number(s[kind]) === id) who.push(s.sg ? s.sg.name : 'вся группа');
    }
    return who;
  }

  function teacherNote(t, self) {
    const a = t.availability.find(x => x.weekday === wd);
    const notes = [];
    if (!a) notes.push('не работает в этот день');
    else if (pair < a.pair_from || pair > a.pair_to) notes.push(`доступен ${a.pair_from}–${a.pair_to}`);
    if (t.absences.some(x => x.date_from <= d.date && x.date_to >= d.date)) notes.push('отсутствует');
    const b = busy('teacher_id', t.id, self);
    if (b.length) notes.push('занят: ' + b.join(', '));
    return notes;
  }

  function drawSlot(s) {
    const item = planItem(Number(s.curriculum_id));
    const kinds = s.kinds();
    if (item && !kinds.includes(s.kind)) s.kind = kinds[0] ?? '';
    const t = teacher(Number(s.teacher_id));

    const itemOptions = items
      .filter(c => KINDS.some(k => c['h_' + k] > 0 && isSplit(c, k) === !!s.sg))
      .map(c => [c.id, `${subjName(c)} — ${teacher(c.teacher_id)?.short_name ?? 'без преподавателя'}`]);

    const kindOptions = kinds.map(k => {
      const p = plannedPairs(item, k);
      const left = p - doneOf(d.progress, item, k, s.sg?.id);
      return [k, `${KIND_NAMES[k]} — осталось ${fmtNum(left)} из ${fmtNum(p)} пар`];
    });

    const teacherOptions = [['', '— выберите —'], ...ref.teachers.filter(x => x.active || x.id === t?.id).map(x => {
      const notes = teacherNote(x, s);
      return [x.id, x.short_name + (notes.length ? ` (${notes.join('; ')})` : '')];
    })];

    let roomInput;
    if (t?.room_id) {
      s.room_id = t.room_id;
      roomInput = field('Аудитория', el('input', { value: `${room(t.room_id)?.name} — закреплена за преподавателем`, disabled: true }));
    } else {
      const roomOptions = [['', '— не выбрана —'], ...ref.rooms.map(r => {
        const notes = [];
        const b = busy('room_id', r.id, s);
        if (b.length) notes.push('занята: ' + b.join(', '));
        const owners = ref.teachers.filter(x => x.room_id === r.id);
        if (owners.length) notes.push('закреплена за ' + owners.map(o => o.short_name).join(', '));
        return [r.id, `${r.name} · ${r.type || 'тип не указан'}, ${r.capacity ?? '?'} мест` + (notes.length ? ` (${notes.join('; ')})` : '')];
      })];
      roomInput = field('Аудитория', select(roomOptions, s.room_id, v => { s.room_id = v; redraw(); }));
    }

    mount(s.node,
      el('div', { class: 'slot-title' }, s.sg ? s.sg.name : 'Вся группа',
        s.curriculum_id ? el('button', { class: 'btn small ghost', onclick: () => { s.curriculum_id = ''; s.kind = ''; s.teacher_id = ''; s.room_id = ''; redraw(); } }, 'Убрать') : null),
      field('Предмет', select([['', s.sg ? '— нет пары у подгруппы —' : '— нет пары —'], ...itemOptions], s.curriculum_id, v => {
        s.curriculum_id = v;
        const it = planItem(Number(v));
        s.teacher_id = it?.teacher_id ?? '';
        s.room_id = '';
        if (it && !teacher(it.teacher_id)?.room_id) s.room_id = suggestRoom(it, s) ?? '';
        redraw();
      })),
      item ? el('div', { class: 'row' },
        field('Вид занятия', select(kindOptions, s.kind, v => { s.kind = v; redraw(); })),
        field('Преподаватель', select(teacherOptions, s.teacher_id, v => {
          s.teacher_id = v;
          if (!teacher(Number(v))?.room_id) s.room_id = suggestRoom(item, s) ?? '';
          redraw();
        }))) : null,
      item ? roomInput : null,
    );
  }

  // Свободная аудитория подходящего типа, не закреплённая за другими.
  function suggestRoom(item, s) {
    const type = subject(item.subject_id)?.room_type;
    const owned = new Set(ref.teachers.filter(t => t.room_id).map(t => t.room_id));
    const free = ref.rooms.filter(r => !owned.has(r.id) && !busy('room_id', r.id, s).length);
    return (free.find(r => !type || r.type === type) ?? free[0])?.id;
  }

  const slotsBox = el('div', { style: 'display:grid;gap:10px' });
  const modeBox = el('div');
  function redraw() {
    mount(modeBox, g.subgroups.length
      ? el('div', { class: 'segmented' },
        el('button', { class: mode === 'whole' ? 'on' : '', onclick: () => { mode = 'whole'; redraw(); } }, 'Вся группа'),
        el('button', { class: mode === 'sub' ? 'on' : '', onclick: () => { mode = 'sub'; redraw(); } }, 'По подгруппам'))
      : null);
    for (const s of allSlots()) s.draw();
    mount(slotsBox, ...slots[mode].map(s => s.node));
  }
  redraw();

  const body = [
    d.status === 'approved' ? el('div', { class: 'notice' }, 'Расписание утверждено. Изменения сразу пересчитают остаток пар по плану.') : null,
    !items.length ? el('div', { class: 'notice warn' }, 'У группы нет учебного плана — добавьте предметы во вкладке «Учебный план».') : null,
    modeBox,
    g.subgroups.length && mode === 'sub' ? el('p', { class: 'hint', style: 'margin:0' }, 'Подгруппа может не иметь пары, если это начало или конец её дня. Лимит пар и окна проверяются для каждой подгруппы отдельно.') : null,
    slotsBox,
    existing.length && d.status === 'approved' ? el('div', { class: 'field' },
      el('span', { class: 'field-label' }, 'Пара не состоялась?'),
      existing.map(l => el('div', { class: 'toolbar', style: 'margin:0' }, lessonText(l),
        el('button', { class: 'btn small danger', onclick: () => setStatus(l.id, 'cancel') }, 'Отменить пару')))) : null,
    cancelled.length ? el('div', { class: 'field' },
      el('span', { class: 'field-label' }, 'Отменённые пары'),
      cancelled.map(l => el('div', { class: 'toolbar', style: 'margin:0' }, lessonText(l),
        el('button', { class: 'btn small', onclick: () => setStatus(l.id, 'restore') }, 'Вернуть')))) : null,
  ];

  let closeModal;
  async function save(lessons) {
    await quiet(async () => {
      state.day = await api('PUT', `/day/${d.date}/cell`, { group_id: g.id, pair, lessons });
      if (state.day.status === 'approved') await reload();
      closeModal();
      drawDay();
    });
  }
  async function setStatus(id, action) {
    await quiet(async () => {
      state.day = await api('POST', `/lessons/${id}/${action}`);
      await reload();
      closeModal();
      drawDay();
    });
  }

  closeModal = modal(`${g.name} · ${pair} пара (${bell.start}–${bell.end}) · ${DAY_SHORT[wd - 1]}, ${fmtShort(d.date)}`, body, close => [
    existing.length ? el('button', { class: 'btn danger left', onclick: () => save([]) }, 'Убрать пару') : null,
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => {
        const lessons = slots[mode].map(s => s.read()).filter(Boolean);
        if (lessons.some(l => !l.kind)) return toast('Выберите вид занятия', 'error');
        save(lessons);
      },
    }, 'Сохранить'),
  ], { wide: g.subgroups.length > 0 });
}

// ---------- Просмотр ----------

async function renderView(main) {
  const v = state.view;
  v.week ??= mondayOf(nextStudyDay(todayISO()));
  if (!['group', 'teacher', 'room'].includes(v.type)) v.type = 'group';
  const lists = {
    group: ref.groups.map(g => [g.id, g.name]),
    teacher: ref.teachers.map(t => [t.id, t.short_name]),
    room: ref.rooms.map(r => [r.id, r.name]),
  };
  if (!lists[v.type].some(([id]) => id === v.id)) v.id = lists[v.type][0]?.[0] ?? null;
  const to = addDays(v.week, 5);
  const data = v.id ? await api('GET', `/view?type=${v.type}&id=${v.id}&from=${v.week}&to=${to}&drafts=${v.drafts ? 1 : 0}`) : { lessons: [] };

  const title = { group: 'Группа', teacher: 'Преподаватель', room: 'Аудитория' }[v.type];
  const name = lists[v.type].find(([id]) => id === v.id)?.[1] ?? '';
  const bells = ref.settings.bells;

  const describe = l => {
    const g = group(l.group_id);
    const sg = l.subgroup_id ? ref.subgroups.get(l.subgroup_id) : null;
    const bits = [];
    if (v.type !== 'group') bits.push(g?.name + (sg ? ' ' + subShort(sg) : ''));
    else if (sg) bits.push(sg.name);
    if (v.type !== 'teacher') bits.push(teacher(l.teacher_id)?.short_name ?? '');
    if (v.type !== 'room') bits.push(room(l.room_id) ? 'ауд. ' + room(l.room_id).name : '');
    return el('div', { class: l.status === 'cancelled' ? 'cancelled' : 'lesson' },
      el('div', { class: 'l-subj' }, subjName(planItem(l.curriculum_id)), ' ', el('span', { class: 'l-kind' }, KIND_SHORT[l.kind])),
      el('div', { class: 'l-meta' }, bits.filter(Boolean).join(' · ')),
      l.day_status !== 'approved' ? el('div', { class: 'draft-mark' }, 'черновик') : null);
  };

  const days = [0, 1, 2, 3, 4, 5].map(i => ({ i, date: addDays(v.week, i) }));
  const at = (date, pair) => data.lessons.filter(l => l.date === date && l.pair === pair);
  const today = todayISO();
  const narrow = window.matchMedia('(max-width: 700px)').matches;

  // На телефоне — дни карточками, на компьютере — таблица недели.
  const body = narrow
    ? el('div', { class: 'day-cards' }, days.map(({ i, date }) => {
      const pairs = bells.filter(b => at(date, b.pair).length);
      return el('div', { class: 'day-card', style: date === today ? 'border-color: var(--accent)' : '' },
        el('h3', {}, `${DAY_FULL[i]}, ${fmtShort(date)}`, date === today ? el('span', { class: 'muted small' }, ' · сегодня') : null),
        pairs.length
          ? pairs.map(b => el('div', { class: 'pair-row' },
            el('div', {}, el('div', { style: 'font-weight:600' }, `${b.pair} пара`), el('div', { class: 'pair-time' }, `${b.start}–${b.end}`)),
            el('div', {}, at(date, b.pair).map(describe))))
          : el('div', { class: 'muted' }, 'Пар нет'));
    }))
    : el('div', { class: 'scroll-x' }, el('table', { class: 'grid week' },
      el('thead', {}, el('tr', {}, el('th', { class: 'gcol' }, 'День'),
        bells.map(b => el('th', {}, `${b.pair} пара`, el('div', { class: 'pair-time' }, `${b.start}–${b.end}`))))),
      el('tbody', {}, days.map(({ i, date }) => el('tr', {},
        el('th', { class: 'gcol' + (date === today ? ' today' : '') }, el('div', { class: 'gname' }, DAY_SHORT[i]), el('div', { class: 'muted small' }, fmtShort(date))),
        bells.map(b => el('td', { class: 'cell view-cell', style: 'cursor:default' }, at(date, b.pair).map(describe))))))));

  mount(main,
    el('h2', { class: 'print-only' }, `${title}: ${name}, неделя с ${fmtDate(v.week)}`),
    !state.admin ? el('h2', { class: 'no-print' }, 'Расписание занятий') : null,
    el('div', { class: 'toolbar no-print' },
      select([['group', 'Группа'], ['teacher', 'Преподаватель'], ['room', 'Аудитория']], v.type, x => { v.type = x; v.id = null; store('viewType', x); render(); }),
      select(lists[v.type], v.id, x => { v.id = Number(x); store('viewId', x); render(); }),
      el('button', { class: 'btn icon', 'aria-label': 'Предыдущая неделя', onclick: () => { v.week = addDays(v.week, -7); render(); } }, '‹'),
      el('span', {}, `${fmtShort(v.week)} – ${fmtShort(to)}`),
      el('button', { class: 'btn icon', 'aria-label': 'Следующая неделя', onclick: () => { v.week = addDays(v.week, 7); render(); } }, '›'),
      v.week !== mondayOf(nextStudyDay(today)) ? el('button', { class: 'btn', onclick: () => { v.week = mondayOf(nextStudyDay(today)); render(); } }, 'Текущая неделя') : null,
      state.admin ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: v.drafts, onchange: e => { v.drafts = e.target.checked; render(); } }), 'Показывать черновики') : null,
      el('div', { class: 'spacer' }),
      !narrow ? el('button', { class: 'btn', onclick: () => window.print() }, 'Печать') : null),
    body,
    state.admin && !v.drafts ? el('p', { class: 'hint no-print' }, 'Показано только утверждённое расписание — так его видят все.') : null,
  );
}

// ---------- Учебный план ----------

async function renderPlan(main) {
  if (!group(state.planGroup)) state.planGroup = ref.groups[0]?.id ?? null;
  const g = group(state.planGroup);
  if (!g) {
    mount(main, el('div', { class: 'card' }, 'Сначала добавьте группу во вкладке «Группы и предметы».'));
    return;
  }
  const items = ref.curriculum
    .filter(c => c.group_id === g.id && (!state.planSemester || c.semester === state.planSemester))
    .sort((a, b) => subjName(a).localeCompare(subjName(b), 'ru'));
  const hpp = ref.settings.hours_per_pair;

  const totals = { all: 0, lecture: 0, practice: 0, lab: 0, done: 0, left: 0 };
  const rows = items.map(c => {
    const st = itemStats(c, ref.progress);
    const hours = c.h_lecture + c.h_practice + c.h_lab;
    totals.all += hours;
    for (const k of KINDS) totals[k] += c['h_' + k];
    totals.done += st.done;
    totals.left += st.left;
    const splitNote = [c.split_practice && g.subgroups.length ? 'практические' : '', c.split_lab && g.subgroups.length ? 'лабораторные' : ''].filter(Boolean);
    return el('tr', { class: st.over ? 'over' : st.left === 0 && st.planned > 0 ? 'done' : '' },
      el('td', {}, el('div', { style: 'font-weight:600' }, subjName(c)),
        el('div', { class: 'muted small' }, st.parts.join(' · ')),
        splitNote.length ? el('div', { class: 'muted small' }, 'По подгруппам: ' + splitNote.join(', ')) : null),
      el('td', {}, teacher(c.teacher_id)?.short_name ?? '—'),
      el('td', { class: 'num' }, c.semester ?? '—'),
      el('td', { class: 'num' }, hours),
      KINDS.map(k => el('td', { class: 'num' }, c['h_' + k] || '—')),
      el('td', { class: 'num' }, fmtNum(st.done)),
      el('td', { class: 'num', style: 'font-weight:700' }, fmtNum(st.left)),
      el('td', { class: 'row-actions' },
        el('button', { class: 'btn small', onclick: () => editPlanItem(g, c) }, 'Изменить'), ' ',
        el('button', { class: 'btn small danger', onclick: () => removeRow('curriculum', c.id, `Удалить «${subjName(c)}» из плана группы ${g.name}? Поставленные пары по нему тоже удалятся.`) }, 'Удалить')));
  });

  mount(main,
    el('div', { class: 'toolbar' },
      el('h2', { style: 'margin:0 12px 0 0' }, 'Учебный план'),
      select(ref.groups.map(x => [x.id, x.name]), g.id, v => { state.planGroup = Number(v); store('planGroup', v); render(); }),
      select([[0, 'Весь год'], [1, '1 семестр'], [2, '2 семестр']], state.planSemester, v => { state.planSemester = Number(v); render(); }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', onclick: () => copyPlan(g) }, 'Скопировать план в группу…'),
      el('button', { class: 'btn primary', onclick: () => editPlanItem(g, null) }, 'Добавить предмет')),
    el('p', { class: 'muted' },
      `${g.specialty || 'Специальность не указана'} · ${g.course ? g.course + ' курс' : ''} · ${g.size ?? '?'} чел.` +
      (g.subgroups.length ? ` · подгруппы: ${g.subgroups.map(s => s.name).join(', ')}` : '') +
      ` · 1 пара = ${hpp} ч. Учитываются только утверждённые дни.`),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Предмет'), el('th', {}, 'Преподаватель'), el('th', { class: 'num' }, 'Сем.'),
        el('th', { class: 'num' }, 'Всего, ч'), KINDS.map(k => el('th', { class: 'num' }, KIND_COL[k])),
        el('th', { class: 'num' }, 'Проведено, пар'), el('th', { class: 'num' }, 'Осталось, пар'), el('th', {}))),
      el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: 10, class: 'muted' }, 'В плане пока нет предметов.'))),
      rows.length ? el('tfoot', {}, el('tr', {},
        el('td', {}, 'Итого'), el('td', {}), el('td', {}),
        el('td', { class: 'num' }, totals.all), KINDS.map(k => el('td', { class: 'num' }, totals[k])),
        el('td', { class: 'num' }, fmtNum(totals.done)), el('td', { class: 'num' }, fmtNum(totals.left)), el('td', {}))) : null)),
    el('p', { class: 'hint' }, 'Зелёным отмечены выполненные предметы, красным — превышение плана. Для предметов по подгруппам «Осталось» считается по отстающей подгруппе, подробности — под названием предмета.'),
  );
}

function editPlanItem(g, c) {
  const v = c ? { ...c } : { group_id: g.id, subject_id: '', teacher_id: '', semester: 1, h_lecture: 0, h_practice: 0, h_lab: 0, split_practice: 0, split_lab: 0 };
  const hpp = ref.settings.hours_per_pair;
  const total = el('strong');
  const updateTotal = () => {
    const sum = ['h_lecture', 'h_practice', 'h_lab'].reduce((s, k) => s + (Number(v[k]) || 0), 0);
    const odd = ['h_lecture', 'h_practice', 'h_lab'].some(k => (Number(v[k]) || 0) % hpp);
    total.textContent = `${sum} ч = ${fmtNum(sum / hpp)} пар` + (odd ? ` · часы не делятся на ${hpp} — будет неполная пара` : '');
  };
  updateTotal();
  const num = key => el('input', { type: 'number', min: 0, step: hpp, value: v[key], oninput: e => { v[key] = e.target.value; updateTotal(); } });
  const hasSub = g.subgroups.length > 0;

  modal(c ? 'Предмет в учебном плане' : `Новый предмет для ${g.name}`, [
    field('Предмет', select([['', '— выберите —'], ...ref.subjects.map(s => [s.id, s.name])], v.subject_id, x => { v.subject_id = x; }),
      'Список предметов — во вкладке «Группы и предметы».'),
    el('div', { class: 'row' },
      field('Преподаватель', select([['', '— не назначен —'], ...ref.teachers.map(t => [t.id, t.short_name])], v.teacher_id, x => { v.teacher_id = x; })),
      field('Семестр', select([[1, '1 семестр'], [2, '2 семестр']], v.semester ?? 1, x => { v.semester = Number(x); }))),
    el('div', { class: 'row' },
      field(KIND_COL.lecture, num('h_lecture')),
      field(KIND_COL.practice, num('h_practice')),
      field(KIND_COL.lab, num('h_lab'))),
    el('div', {}, 'Всего: ', total),
    el('div', { class: 'field' },
      el('span', { class: 'field-label' }, 'Деление на подгруппы'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!v.split_practice, disabled: !hasSub, onchange: e => { v.split_practice = e.target.checked; } }), 'Практические занятия по подгруппам'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!v.split_lab, disabled: !hasSub, onchange: e => { v.split_lab = e.target.checked; } }), 'Лабораторные занятия по подгруппам'),
      el('span', { class: 'hint' }, hasSub
        ? 'Для каждой подгруппы ведётся свой счётчик пар — каждая должна пройти все часы.'
        : 'У группы нет подгрупп — их можно добавить во вкладке «Группы и предметы».')),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        await api(c ? 'PUT' : 'POST', c ? `/curriculum/${c.id}` : '/curriculum', v);
        await reload();
        close();
        render();
      }),
    }, 'Сохранить'),
  ]);
}

function copyPlan(g) {
  let target = ref.groups.find(x => x.id !== g.id)?.id;
  modal(`Скопировать план группы ${g.name}`, [
    field('В группу', select(ref.groups.filter(x => x.id !== g.id).map(x => [x.id, x.name]), target, v => { target = Number(v); })),
    el('p', { class: 'hint', style: 'margin:0' }, 'Предметы добавятся к уже существующему плану выбранной группы.'),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        const r = await api('POST', '/curriculum/copy', { from_group: g.id, to_group: target });
        await reload();
        close();
        toast(`Скопировано предметов: ${r.copied}`);
        state.planGroup = target;
        render();
      }),
    }, 'Скопировать'),
  ]);
}

async function removeRow(kind, id, question) {
  if (!confirm(question)) return;
  await quiet(async () => {
    await api('DELETE', `/${kind}/${id}`);
    await reload();
    render();
  });
}

// ---------- Преподаватели ----------

async function renderTeachers(main) {
  mount(main,
    el('div', { class: 'toolbar' }, el('h2', { style: 'margin:0' }, 'Преподаватели'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn primary', onclick: () => editTeacher(null) }, 'Добавить преподавателя')),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'ФИО'), el('th', {}, 'В расписании'), el('th', {}, 'Закреплённая аудитория'),
        el('th', {}, 'Доступность (пары)'), el('th', {}, 'Отсутствия'), el('th', {}))),
      el('tbody', {}, ref.teachers.map(t => el('tr', { style: t.active ? '' : 'opacity:.55' },
        el('td', {}, t.full_name, t.active ? null : el('div', { class: 'muted small' }, 'не активен')),
        el('td', {}, t.short_name),
        el('td', {}, room(t.room_id)?.name ?? '—'),
        el('td', {}, availabilityText(t)),
        el('td', { class: 'small' }, t.absences.filter(a => a.date_to >= todayISO()).map(a => el('div', {}, `${fmtShort(a.date_from)}–${fmtShort(a.date_to)} ${a.reason}`))),
        el('td', { class: 'row-actions' },
          el('button', { class: 'btn small', onclick: () => editTeacher(t) }, 'Изменить'), ' ',
          el('button', { class: 'btn small danger', onclick: () => removeRow('teachers', t.id, `Удалить преподавателя ${t.short_name}? В его парах преподаватель станет не указан.`) }, 'Удалить'))))))),
  );
}

function shortFromFull(full) {
  const [last, ...rest] = full.trim().split(/\s+/);
  return last ? last + (rest.length ? ' ' + rest.map(x => x[0].toUpperCase() + '.').join('') : '') : '';
}

function editTeacher(t) {
  const pairs = ref.settings.pairs_per_day;
  const v = t
    ? { full_name: t.full_name, short_name: t.short_name, room_id: t.room_id ?? '', active: !!t.active }
    : { full_name: '', short_name: '', room_id: '', active: true };
  const avail = [1, 2, 3, 4, 5, 6].map(wd => {
    const a = t?.availability.find(x => x.weekday === wd);
    return { weekday: wd, on: !!a || (!t && wd <= 5), pair_from: a?.pair_from ?? 1, pair_to: a?.pair_to ?? pairs };
  });
  const shortInput = el('input', { value: v.short_name, oninput: e => { v.short_name = e.target.value; } });
  const pairOpts = Array.from({ length: pairs }, (_, i) => [i + 1, String(i + 1)]);

  const availRows = avail.map(a => {
    const from = select(pairOpts, a.pair_from, x => { a.pair_from = Number(x); }, { disabled: !a.on });
    const to = select(pairOpts, a.pair_to, x => { a.pair_to = Number(x); }, { disabled: !a.on });
    return el('tr', {},
      el('td', {}, el('label', { class: 'check' }, el('input', {
        type: 'checkbox', checked: a.on,
        onchange: e => { a.on = e.target.checked; from.disabled = to.disabled = !a.on; },
      }), DAY_FULL[a.weekday - 1])),
      el('td', {}, 'с ', from, ' по ', to, ' пару'));
  });

  const absBox = el('div');
  const drawAbsences = () => {
    if (!t) { mount(absBox, el('p', { class: 'hint', style: 'margin:0' }, 'Отсутствия можно добавить после сохранения.')); return; }
    const cur = teacher(t.id);
    const nf = { date_from: todayISO(), date_to: todayISO(), reason: 'Больничный' };
    mount(absBox,
      ...cur.absences.map(a => el('div', { class: 'toolbar', style: 'margin:0 0 4px' },
        `${fmtDate(a.date_from)} – ${fmtDate(a.date_to)}: ${a.reason}`,
        el('button', { class: 'btn small danger', onclick: () => quiet(async () => { await api('DELETE', `/absences/${a.id}`); await reload(); drawAbsences(); }) }, 'Удалить'))),
      el('div', { class: 'toolbar', style: 'margin:0' },
        el('input', { type: 'date', value: nf.date_from, onchange: e => { nf.date_from = e.target.value; } }), '–',
        el('input', { type: 'date', value: nf.date_to, onchange: e => { nf.date_to = e.target.value; } }),
        select([['Больничный', 'Больничный'], ['Командировка', 'Командировка'], ['Отпуск', 'Отпуск'], ['Другое', 'Другое']], nf.reason, x => { nf.reason = x; }),
        el('button', {
          class: 'btn small',
          onclick: () => quiet(async () => {
            if (nf.date_to < nf.date_from) throw new Error('Дата окончания раньше даты начала');
            await api('POST', '/absences', { teacher_id: t.id, ...nf });
            await reload();
            drawAbsences();
          }),
        }, 'Добавить')));
  };
  drawAbsences();

  modal(t ? t.full_name : 'Новый преподаватель', [
    el('div', { class: 'row' },
      field('ФИО', el('input', {
        value: v.full_name,
        oninput: e => {
          const auto = !v.short_name || v.short_name === shortFromFull(v.full_name);
          v.full_name = e.target.value;
          if (auto) { v.short_name = shortFromFull(v.full_name); shortInput.value = v.short_name; }
        },
      })),
      field('Как писать в расписании', shortInput)),
    el('div', { class: 'row' },
      field('Закреплённая аудитория', select([['', '— нет —'], ...ref.rooms.map(r => [r.id, `${r.name} (${r.type || 'тип не указан'})`])], v.room_id, x => { v.room_id = x; }),
        'Если выбрана, все пары преподавателя ставятся только в эту аудиторию.'),
      field('Статус', el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: v.active, onchange: e => { v.active = e.target.checked; } }), 'Работает'))),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'В какие дни и на какие пары можно ставить'),
      el('table', { class: 'avail-table' }, el('tbody', {}, availRows))),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Отсутствия (больничный, командировка, отпуск)'), absBox),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        const bad = avail.find(a => a.on && a.pair_from > a.pair_to);
        if (bad) throw new Error(`${DAY_FULL[bad.weekday - 1]}: «с» должно быть не больше «по»`);
        const body = { ...v, availability: avail.filter(a => a.on).map(({ weekday: w, pair_from: f, pair_to: tt }) => ({ weekday: w, pair_from: f, pair_to: tt })) };
        await api(t ? 'PUT' : 'POST', t ? `/teachers/${t.id}` : '/teachers', body);
        await reload();
        close();
        render();
      }),
    }, 'Сохранить'),
  ], { wide: true });
}

// ---------- Аудитории ----------

async function renderRooms(main) {
  mount(main,
    el('div', { class: 'toolbar' }, el('h2', { style: 'margin:0' }, 'Аудитории'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn primary', onclick: () => editRoom(null) }, 'Добавить аудиторию')),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Аудитория'), el('th', {}, 'Корпус'), el('th', {}, 'Тип'),
        el('th', { class: 'num' }, 'Мест'), el('th', {}, 'Закреплена за'), el('th', {}))),
      el('tbody', {}, ref.rooms.map(r => el('tr', {},
        el('td', { style: 'font-weight:600' }, r.name),
        el('td', {}, r.building || '—'),
        el('td', {}, r.type || '—'),
        el('td', { class: 'num' }, r.capacity ?? '—'),
        el('td', {}, ref.teachers.filter(t => t.room_id === r.id).map(t => t.short_name).join(', ') || el('span', { class: 'muted' }, 'общая')),
        el('td', { class: 'row-actions' },
          el('button', { class: 'btn small', onclick: () => editRoom(r) }, 'Изменить'), ' ',
          el('button', { class: 'btn small danger', onclick: () => removeRow('rooms', r.id, `Удалить аудиторию ${r.name}?`) }, 'Удалить'))))))),
    el('p', { class: 'hint' }, 'Закрепить аудиторию за преподавателем можно в его карточке во вкладке «Преподаватели».'),
  );
}

function editRoom(r) {
  const v = r ? { ...r } : { name: '', building: '', capacity: 30, type: 'Лекционная' };
  modal(r ? `Аудитория ${r.name}` : 'Новая аудитория', [
    el('div', { class: 'row' },
      field('Номер или название', el('input', { value: v.name, oninput: e => { v.name = e.target.value; } })),
      field('Корпус', el('input', { value: v.building, oninput: e => { v.building = e.target.value; } }))),
    el('div', { class: 'row' },
      field('Тип', select([['', '— не указан —'], ...ROOM_TYPES.map(x => [x, x])], v.type, x => { v.type = x; })),
      field('Мест', el('input', { type: 'number', min: 0, value: v.capacity ?? '', oninput: e => { v.capacity = e.target.value; } }))),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        await api(r ? 'PUT' : 'POST', r ? `/rooms/${r.id}` : '/rooms', v);
        await reload();
        close();
        render();
      }),
    }, 'Сохранить'),
  ]);
}

// ---------- Группы и предметы ----------

async function renderGroups(main) {
  mount(main,
    el('div', { class: 'toolbar' }, el('h2', { style: 'margin:0' }, 'Группы'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn primary', onclick: () => editGroup(null) }, 'Добавить группу')),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Группа'), el('th', {}, 'Специальность'), el('th', { class: 'num' }, 'Курс'),
        el('th', { class: 'num' }, 'Студентов'), el('th', {}, 'Подгруппы'), el('th', {}))),
      el('tbody', {}, ref.groups.map(g => el('tr', {},
        el('td', { style: 'font-weight:600' }, g.name),
        el('td', {}, g.specialty || '—'),
        el('td', { class: 'num' }, g.course ?? '—'),
        el('td', { class: 'num' }, g.size ?? '—'),
        el('td', {}, g.subgroups.map(s => s.name).join(', ') || el('span', { class: 'muted' }, 'не делится')),
        el('td', { class: 'row-actions' },
          el('button', { class: 'btn small', onclick: () => editGroup(g) }, 'Изменить'), ' ',
          el('button', { class: 'btn small danger', onclick: () => removeRow('groups', g.id, `Удалить группу ${g.name} вместе с учебным планом и расписанием?`) }, 'Удалить'))))))),
    el('div', { class: 'toolbar', style: 'margin-top:28px' }, el('h2', { style: 'margin:0' }, 'Предметы'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn primary', onclick: () => editSubject(null) }, 'Добавить предмет')),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Предмет'), el('th', {}, 'Нужный тип аудитории'), el('th', {}))),
      el('tbody', {}, ref.subjects.map(s => el('tr', {},
        el('td', {}, s.name),
        el('td', {}, s.room_type || el('span', { class: 'muted' }, 'любая')),
        el('td', { class: 'row-actions' },
          el('button', { class: 'btn small', onclick: () => editSubject(s) }, 'Изменить'), ' ',
          el('button', { class: 'btn small danger', onclick: () => removeRow('subjects', s.id, `Удалить предмет «${s.name}» из всех учебных планов?`) }, 'Удалить'))))))),
  );
}

function editGroup(g) {
  const v = g ? { name: g.name, specialty: g.specialty, course: g.course ?? '', size: g.size ?? '' } : { name: '', specialty: '', course: 1, size: 25 };
  const subs = g ? g.subgroups.map(s => ({ id: s.id, name: s.name })) : [];
  const subsBox = el('div', { style: 'display:grid;gap:6px' });
  const drawSubs = () => mount(subsBox,
    ...subs.map((s, i) => el('div', { class: 'toolbar', style: 'margin:0' },
      el('input', { value: s.name, oninput: e => { s.name = e.target.value; } }),
      el('button', { class: 'btn small danger', onclick: () => { subs.splice(i, 1); drawSubs(); } }, 'Удалить'))),
    el('div', {}, el('button', { class: 'btn small', onclick: () => { subs.push({ name: `Подгруппа ${subs.length + 1}` }); drawSubs(); } }, 'Добавить подгруппу')));
  drawSubs();

  modal(g ? `Группа ${g.name}` : 'Новая группа', [
    el('div', { class: 'row' },
      field('Название', el('input', { value: v.name, oninput: e => { v.name = e.target.value; } })),
      field('Курс', el('input', { type: 'number', min: 1, max: 5, value: v.course, oninput: e => { v.course = e.target.value; } })),
      field('Студентов', el('input', { type: 'number', min: 0, value: v.size, oninput: e => { v.size = e.target.value; } }))),
    field('Специальность', el('input', { value: v.specialty, oninput: e => { v.specialty = e.target.value; } })),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Подгруппы'), subsBox,
      el('span', { class: 'hint' }, 'Если группа делится (например, на лабораторных), добавьте подгруппы. При удалении подгруппы удаляются и её пары.')),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        await api(g ? 'PUT' : 'POST', g ? `/groups/${g.id}` : '/groups', { ...v, subgroups: subs });
        await reload();
        close();
        render();
      }),
    }, 'Сохранить'),
  ]);
}

function editSubject(s) {
  const v = s ? { ...s } : { name: '', room_type: '' };
  modal(s ? 'Предмет' : 'Новый предмет', [
    field('Название', el('input', { value: v.name, oninput: e => { v.name = e.target.value; } })),
    field('Нужный тип аудитории', select([['', 'Любая'], ...ROOM_TYPES.map(x => [x, x])], v.room_type, x => { v.room_type = x; }),
      'Например, лабораторные по информатике — только в компьютерном классе.'),
  ], close => [
    el('button', { class: 'btn', onclick: close }, 'Отмена'),
    el('button', {
      class: 'btn primary',
      onclick: () => quiet(async () => {
        await api(s ? 'PUT' : 'POST', s ? `/subjects/${s.id}` : '/subjects', v);
        await reload();
        close();
        render();
      }),
    }, 'Сохранить'),
  ]);
}

// ---------- Нагрузка ----------

async function renderReport(main) {
  const r = await api('GET', '/report/teachers');
  mount(main,
    el('div', { class: 'toolbar' }, el('h2', { style: 'margin:0' }, 'Нагрузка преподавателей'), el('div', { class: 'spacer' }),
      el('button', { class: 'btn no-print', onclick: () => window.print() }, 'Печать')),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Преподаватель'), el('th', { class: 'num' }, 'По плану, ч'),
        el('th', { class: 'num' }, 'Проведено, ч'), el('th', { class: 'num' }, 'За этот месяц, ч'),
        el('th', { class: 'num' }, 'Осталось, ч'), el('th', {}, 'Выполнение'))),
      el('tbody', {}, r.rows.map(x => {
        const pct = x.planned_h ? Math.min(100, Math.round((x.done_h / x.planned_h) * 100)) : 0;
        return el('tr', {},
          el('td', {}, x.name),
          el('td', { class: 'num' }, x.planned_h),
          el('td', { class: 'num' }, x.done_h),
          el('td', { class: 'num' }, x.month_h),
          el('td', { class: 'num' }, Math.max(0, x.planned_h - x.done_h)),
          el('td', {}, x.planned_h ? el('div', { style: 'display:flex;align-items:center;gap:8px' },
            el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })), `${pct}%`) : el('span', { class: 'muted small' }, 'нет часов в плане')));
      })))),
    el('p', { class: 'hint' }, '«По плану» — часы из учебных планов, где преподаватель указан основным (пары по подгруппам считаются для каждой подгруппы). «Проведено» — по утверждённым дням, в том числе замены.'),
  );
}

// ---------- Настройки ----------

async function renderSettings(main) {
  const s = ref.settings;
  const v = { max_pairs: s.max_pairs, hours_per_pair: s.hours_per_pair, bells: s.bells.map(b => ({ ...b })) };
  const log = await api('GET', '/log');
  mount(main,
    el('h2', {}, 'Настройки'),
    el('div', { class: 'card', style: 'max-width:640px;display:grid;gap:14px' },
      el('div', { class: 'row' },
        field('Максимум пар в день у группы/подгруппы', select(Array.from({ length: s.pairs_per_day }, (_, i) => [i + 1, String(i + 1)]), v.max_pairs, x => { v.max_pairs = Number(x); })),
        field('Академических часов в одной паре', select([[1, '1'], [2, '2'], [3, '3'], [4, '4']], v.hours_per_pair, x => { v.hours_per_pair = Number(x); }))),
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Звонки'),
        el('table', { class: 'avail-table' }, el('tbody', {}, v.bells.map(b => el('tr', {},
          el('td', {}, `${b.pair} пара`),
          el('td', {}, el('input', { type: 'time', value: b.start, onchange: e => { b.start = e.target.value; } }), ' – ',
            el('input', { type: 'time', value: b.end, onchange: e => { b.end = e.target.value; } }))))))),
      el('div', {}, el('button', {
        class: 'btn primary',
        onclick: () => quiet(async () => {
          await api('PUT', '/settings', v);
          await reload();
          toast('Настройки сохранены');
          render();
        }),
      }, 'Сохранить настройки'))),
    passwordCard(),
    el('h3', { style: 'margin-top:28px' }, 'Журнал изменений'),
    el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Когда'), el('th', {}, 'День расписания'), el('th', {}, 'Действие'), el('th', {}, 'Подробности'))),
      el('tbody', {}, log.length ? log.map(x => el('tr', {},
        el('td', { class: 'small' }, new Date(x.at).toLocaleString('ru-RU')),
        el('td', {}, x.date ? fmtShort(x.date) + '.' + x.date.slice(0, 4) : '—'),
        el('td', {}, x.action),
        el('td', {}, x.details))) : el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Изменений пока нет.'))))),
  );
}

function passwordCard() {
  const v = { current: '', next: '', repeat: '' };
  const input = (key, autocomplete) => el('input', { type: 'password', autocomplete, oninput: e => { v[key] = e.target.value; } });
  return el('div', { class: 'card', style: 'max-width:640px;display:grid;gap:14px;margin-top:20px' },
    el('h3', { style: 'margin:0' }, 'Пароль администратора'),
    el('div', { class: 'row' },
      field('Текущий пароль', input('current', 'current-password')),
      field('Новый пароль', input('next', 'new-password'), 'Не короче 8 символов'),
      field('Повторите новый', input('repeat', 'new-password'))),
    el('div', {}, el('button', {
      class: 'btn',
      onclick: () => quiet(async () => {
        if (v.next !== v.repeat) throw new Error('Новые пароли не совпадают');
        await api('PUT', '/password', { current: v.current, next: v.next });
        toast('Пароль изменён. Другие вошедшие устройства вышли из системы');
        render();
      }),
    }, 'Сменить пароль')));
}

// ---------- Запуск ----------

(async () => {
  try {
    state.admin = (await api('GET', '/me')).admin;
    await reload();
  } catch (e) {
    $('#main').replaceChildren(el('div', { class: 'card' }, 'Сервер недоступен: ' + e.message));
    return;
  }
  render();
})();
