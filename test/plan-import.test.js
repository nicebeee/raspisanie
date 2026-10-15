import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from '../js/vendor/xlsx.mjs';
import { parsePlanWorkbook, planForCourse, guessCourse, isDiscipline } from '../js/plan-import.js';
import { createStore } from '../js/store.js';

// Небольшой план того же устройства, что выгрузка «Учебный план»: заголовки в 3 строках,
// строка с номерами столбцов, по 6 столбцов на семестр, 4 семестра. offset сдвигает таблицу вправо.
function makeWorkbook({ offset = 0, startYear = 2025 } = {}) {
  const pad = n => Array(n).fill('');
  const sem = n => ['Семестр ' + n, '', '', '', '', ''];
  const sub = () => ['Максим.', 'Обязательная', 'Лекции, уроки', 'Пр. занятия', 'Лаб. занятия', 'Курс. проектир.'];
  const hours = (...v) => v.flatMap(([ob, l, p, lb, kp]) => ['', ob, l, p, lb, kp]);
  const rows = [
    [...pad(1), 'Индекс', 'Наименование циклов, разделов, дисциплин', ...pad(offset)],
    [],
    [...pad(3 + offset), sem(1), sem(2), sem(3), sem(4)].flat(),
    [],
    [...pad(3 + offset), sub(), sub(), sub(), sub()].flat(),
    [],
    [...pad(3 + offset), ...Array.from({ length: 24 }, (_, i) => i + 25)],
    ['1', 'ОП', 'Общепрофессиональный цикл', ...pad(offset), ...hours([0], [0], [100, 60, 40, 0, 0], [0])],
    ['2', 'ОП.01', 'Материаловедение', ...pad(offset), ...hours([30, 20, 10, 0, 0], [0], [36, 22, 14, 0, 0], [0])],
    ['3', 'МДК 01.04 ', 'Техническая  диагностика', ...pad(offset), ...hours([0], [0], [0], [64, 30, 14, 0, 20])],
    ['4', 'ОП.00', 'Итого по разделу', ...pad(offset), ...hours([0], [0], [999, 999, 0, 0, 0], [0])],
    ['5', 'УП.01.01', 'Учебная практика', ...pad(offset), ...hours([0], [0], [72, 0, 72, 0, 0], [0])],
    ['6', 'ПМ.01', 'Профмодуль целиком', ...pad(offset), ...hours([0], [0], [0], [64, 30, 14, 0, 20])],
    ['7', 'СГ.04', 'Физическая культура', ...pad(offset), ...hours([0], [0], [10, 2, 8, 0, 0], [20, 0, 20, 0, 0])],
  ].map(r => r.map(c => (c === 0 ? '' : c)));
  const title = [
    ['', '23.01.17', '', 'Мастер по ремонту и обслуживанию автомобилей'],
    ['форма обучения', 'Очная', 'год начала подготовки по УП', '', startYear ?? ''],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(title), 'Титул');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'План');
  // Прогоняем через настоящий .xls, как у пользователей
  return XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }), { type: 'buffer' });
}

test('какие строки считаются дисциплинами', () => {
  for (const ok of ['ОДБ.01', 'СГ.02', 'МДК.01.03', 'ПД.01', 'ОГСЭ.03']) assert.ok(isDiscipline(ok), ok);
  for (const no of ['ОП', 'ОП.00', 'ПМ.01', 'ПM.01.ЭК', 'УП.01.01', 'ПП.02.01', 'ПДП', 'СГ.', '']) assert.ok(!isDiscipline(no), no);
});

for (const offset of [0, 3]) {
  test(`разбор плана: столбцы по заголовкам (сдвиг ${offset})`, () => {
    const plan = parsePlanWorkbook(XLSX, makeWorkbook({ offset }));
    assert.equal(plan.specialty, '23.01.17 Мастер по ремонту и обслуживанию автомобилей');
    assert.equal(plan.startYear, 2025);
    assert.equal(plan.semesterCount, 4);
    assert.deepEqual(plan.disciplines.map(d => d.index), ['ОП.01', 'МДК.01.04', 'СГ.04']);

    const course2 = planForCourse(plan, 2);
    const byIndex = Object.fromEntries(course2.map(i => [i.index, i]));
    assert.deepEqual(
      { l: byIndex['ОП.01'].lecture, p: byIndex['ОП.01'].practice, s: byIndex['ОП.01'].semester },
      { l: 22, p: 14, s: 1 });
    // Курсовое проектирование идёт в практические, двойной пробел в названии убран
    assert.equal(byIndex['МДК.01.04'].practice, 34);
    assert.equal(byIndex['МДК.01.04'].name, 'Техническая диагностика');
    assert.equal(byIndex['МДК.01.04'].semester, 2);
    // Часы обоих семестров складываются, семестр — «весь год»
    assert.deepEqual([byIndex['СГ.04'].lecture, byIndex['СГ.04'].practice, byIndex['СГ.04'].semester], [2, 28, null]);
  });
}

test('курс по году начала; без года — не угадываем', () => {
  const plan = parsePlanWorkbook(XLSX, makeWorkbook({ startYear: 2025 }));
  assert.equal(guessCourse(plan, new Date('2026-10-15')), 2);
  assert.equal(guessCourse(plan, new Date('2026-03-01')), 1);
  assert.equal(guessCourse(plan, new Date('2030-10-01')), null, 'курс за пределами срока обучения');
  assert.equal(guessCourse(parsePlanWorkbook(XLSX, makeWorkbook({ startYear: null }))), null);
});

test('загрузка в группу: новые предметы создаются, существующие обновляют часы, преподаватель сохраняется', () => {
  const data = structuredClone(JSON.parse(fs.readFileSync(new URL('./fixtures/demo.json', import.meta.url), 'utf8')));
  const st = createStore(data);
  const call = (method, path, body) => st.handle(method, path, new URLSearchParams(), body, { admin: true });
  const is21 = data.groups.find(g => g.name === 'ИС-21');
  const eng = data.curriculum.find(c => c.group_id === is21.id && data.subjects.find(s => s.id === c.subject_id).name === 'Иностранный язык');

  const r = call('POST', '/curriculum/import', {
    group_id: is21.id,
    items: [
      { name: 'Иностранный язык', lecture: 0, practice: 80, lab: 0, semester: null },
      { name: 'Материаловедение', lecture: 22, practice: 14, lab: 0, semester: 1 },
    ],
  });
  assert.deepEqual([r.created, r.updated, r.subjects_created], [1, 1, 1]);
  assert.equal(eng.h_practice, 80);
  assert.ok(eng.teacher_id, 'преподаватель не сброшен');
  assert.equal(eng.split_practice, 1, 'деление на подгруппы не сброшено');

  const r2 = call('POST', '/curriculum/import', {
    new_group: { name: 'АВТ-25', specialty: '23.01.17', course: 2 },
    items: [{ name: 'Материаловедение', lecture: 22, practice: 14, lab: 0, semester: 1 }],
  });
  const g = data.groups.find(x => x.id === r2.group_id);
  assert.equal(g.name, 'АВТ-25');
  assert.equal(r2.subjects_created, 0, 'предмет переиспользован');
  assert.throws(() => call('POST', '/curriculum/import', { new_group: { name: 'АВТ-25' }, items: [{ name: 'X' }] }), /уже есть/);
});
