// Разбор учебного плана из Excel — выгрузки «Учебный план» (листы «Титул» и «План»).
// Столбцы в разных файлах сдвинуты, поэтому всё ищется по тексту заголовков, а не по буквам.
// Модуль не зависит от браузера: XLSX (SheetJS) передаётся снаружи.

const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const low = s => norm(s).toLowerCase();

// Заголовок столбца внутри блока семестра → вид занятия в нашей программе.
// Семинарские, индивидуальные и курсовое проектирование считаем практическими.
const KIND_BY_HEADER = [
  [/^лекц/, 'lecture'],
  [/^пр\.?\s*занят/, 'practice'],
  [/^лаб/, 'lab'],
  [/^семин/, 'practice'],
  [/^индивид\.?\s*занят/, 'practice'],
  [/^курс\.?\s*проект/, 'practice'],
];

// «МДК 01.04 » → «МДК.01.04»
const normIndex = s => norm(s).replace(/\s+/g, '.').replace(/\.+$/, '');

// Дисциплина — индекс вида ОДБ.01, СГ.02, МДК.01.03. Итоговые строки (.00),
// профмодули целиком (ПМ — сумма своих МДК), практики (УП, ПП, ПДП) и экзамены пропускаем.
export function isDiscipline(index) {
  if (!/^[А-ЯЁA-Z]+(\.\d+)+$/.test(index)) return false;
  if (/\.00$/.test(index)) return false;
  return !/^(ПМ|ПM|УП|ПП|ПДП)\./.test(index);
}

function sheetRows(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

function readTitle(XLSX, wb) {
  const ws = wb.Sheets['Титул'];
  const out = { code: '', name: '', startYear: null };
  if (!ws) return out;
  for (const r of sheetRows(XLSX, ws)) {
    const cells = r.map(norm);
    const nextAfter = i => cells.slice(i + 1).find(Boolean) ?? '';
    cells.forEach((c, i) => {
      if (!out.code && /^\d\d\.\d\d\.\d\d$/.test(c)) {
        out.code = c;
        out.name = nextAfter(i);
      }
      if (/год начала подготовки/i.test(c)) {
        const y = Number(nextAfter(i));
        if (Number.isInteger(y) && y > 1990 && y < 2100) out.startYear = y;
      }
    });
  }
  return out;
}

export function parsePlanWorkbook(XLSX, wb) {
  const ws = wb.Sheets['План'];
  if (!ws) throw new Error('В файле нет листа «План» — это не выгрузка учебного плана');
  const rows = sheetRows(XLSX, ws);

  // Строка с «Семестр 1», «Семестр 2», …
  const semRow = rows.slice(0, 10).findIndex(r => r.some(c => /^семестр\s+\d+$/.test(low(c))));
  if (semRow < 0) throw new Error('Не нашёл на листе «План» столбцы «Семестр 1», «Семестр 2»…');
  const starts = rows[semRow]
    .map((c, i) => [low(c), i])
    .filter(([c]) => /^семестр\s+\d+$/.test(c))
    .map(([c, i]) => ({ n: Number(c.split(/\s+/)[1]), col: i }));

  // Столбцы «Индекс» и «Наименование…»
  const headRows = rows.slice(0, semRow + 4);
  const findCol = re => {
    for (const r of headRows) {
      const i = r.findIndex(c => re.test(low(c)));
      if (i >= 0) return i;
    }
    return -1;
  };
  const indexCol = findCol(/^индекс$/);
  const nameCol = findCol(/^наименование/);
  if (indexCol < 0 || nameCol < 0) throw new Error('Не нашёл столбцы «Индекс» и «Наименование» на листе «План»');

  // Подпись столбца — самая нижняя непустая строка заголовка над ним
  // (строку с номерами столбцов «1, 2, 3…» пропускаем).
  const label = col => {
    for (let r = semRow + 4; r > semRow; r--) {
      const v = low(rows[r]?.[col]);
      if (v && !/^\d+$/.test(v)) return v;
    }
    return '';
  };
  const semesters = starts.map((s, k) => {
    const end = starts[k + 1]?.col ?? Math.max(...rows.slice(0, semRow + 5).map(r => r.length));
    const cols = [];
    for (let c = s.col; c < end; c++) {
      const kind = KIND_BY_HEADER.find(([re]) => re.test(label(c)))?.[1];
      if (kind) cols.push({ col: c, kind });
    }
    return { n: s.n, cols };
  });
  if (!semesters.some(s => s.cols.length)) throw new Error('Не нашёл в семестрах столбцы «Лекции», «Пр. занятия», «Лаб. занятия»');

  const disciplines = [];
  for (const r of rows.slice(semRow + 1)) {
    const index = normIndex(r[indexCol]);
    if (!isDiscipline(index)) continue;
    const bySem = {};
    for (const s of semesters) {
      const h = { lecture: 0, practice: 0, lab: 0 };
      for (const { col, kind } of s.cols) h[kind] += Number(r[col]) || 0;
      if (h.lecture || h.practice || h.lab) bySem[s.n] = h;
    }
    disciplines.push({ index, name: norm(r[nameCol]), semesters: bySem });
  }

  const title = readTitle(XLSX, wb);
  return {
    specialty: [title.code, title.name].filter(Boolean).join(' '),
    startYear: title.startYear,
    semesterCount: Math.max(...semesters.map(s => s.n)),
    disciplines,
  };
}

// Учебный год начинается 1 сентября; с августа уже считаем новый год.
export function academicYearStart(date = new Date()) {
  return date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;
}

export function guessCourse(plan, date = new Date()) {
  if (!plan.startYear) return null;
  const course = academicYearStart(date) - plan.startYear + 1;
  return course >= 1 && course <= Math.ceil(plan.semesterCount / 2) ? course : null;
}

// Предметы одного курса: часы двух его семестров складываются в год.
// semester: 1 или 2 — если часы только в одном семестре, null — весь год.
export function planForCourse(plan, course) {
  const s1 = course * 2 - 1, s2 = course * 2;
  const items = [];
  for (const d of plan.disciplines) {
    const a = d.semesters[s1], b = d.semesters[s2];
    if (!a && !b) continue;
    const sum = k => (a?.[k] ?? 0) + (b?.[k] ?? 0);
    items.push({
      index: d.index,
      name: d.name,
      lecture: sum('lecture'),
      practice: sum('practice'),
      lab: sum('lab'),
      semester: a && b ? null : a ? 1 : 2,
      bySemester: { 1: a ?? null, 2: b ?? null },
    });
  }
  // Одинаковые названия в одном курсе различаем индексом, чтобы не слить разные дисциплины.
  const count = new Map();
  for (const it of items) count.set(low(it.name), (count.get(low(it.name)) ?? 0) + 1);
  for (const it of items) if (count.get(low(it.name)) > 1) it.name = `${it.name} (${it.index})`;
  return items;
}
