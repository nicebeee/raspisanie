import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../js/store.js';
import { settingsOf, semesterOf, studyDaysLeft, validateDay } from '../js/logic.js';

const demo = JSON.parse(fs.readFileSync(new URL('./fixtures/demo.json', import.meta.url), 'utf8'));
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

function setup(settings = {}) {
  const data = structuredClone(demo);
  data.settings = { ...data.settings, ...settings };
  const st = createStore(data);
  const call = (method, path, body = {}) => st.handle(method, path, new URLSearchParams(), body, { admin: true });
  return { data, call };
}

test('старые настройки («максимум 4») превращаются в «от 4 до 6»', () => {
  assert.deepEqual([settingsOf({ settings: { max_pairs: 4 } }).min_pairs, settingsOf({ settings: { max_pairs: 4 } }).max_pairs], [4, 6]);
  assert.equal(settingsOf({ settings: { min_pairs: 3, max_pairs: 5 } }).max_pairs, 5);
});

test('семестр и оставшиеся учебные дни по датам из настроек', () => {
  const data = { settings: { min_pairs: 4, semester1_end: '2026-12-31', semester2_end: '2027-06-30', study_days: 5 } };
  assert.equal(semesterOf(data, '2026-11-02'), 1);
  assert.equal(semesterOf(data, '2027-02-01'), 2);
  assert.equal(semesterOf({ settings: {} }, '2026-11-02'), null);
  assert.equal(studyDaysLeft(data, '2026-12-28'), 4, 'пн–чт до 31 декабря');
});

test('по умолчанию у каждой группы 4 пары с 1-й, без ошибок', () => {
  const { data, call } = setup();
  const r = call('POST', '/auto', { dates: WEEK, group_ids: data.groups.map(g => g.id) });
  for (const d of WEEK) assert.deepEqual(validateDay(data, d).filter(i => i.level === 'error').map(i => i.text), [], d);
  const short = r.report.filter(x => x.group && x.placed < 4);
  assert.ok(short.length <= 1, JSON.stringify(short));
});

test('мало дней до конца семестра — группа получает больше пар (до 6)', () => {
  const { data, call } = setup({ semester1_end: '2026-11-13' });
  const r = call('POST', '/auto', { dates: WEEK, group_ids: data.groups.map(g => g.id) });
  assert.ok(r.report.some(x => x.placed >= 5), JSON.stringify(r.report.map(x => x.placed)));
  assert.ok(r.report.every(x => !x.group || x.placed <= 6));
  for (const d of WEEK) assert.deepEqual(validateDay(data, d).filter(i => i.level === 'error').map(i => i.text), [], d);
});

test('предметы другого семестра не ставятся', () => {
  const { data, call } = setup({ semester1_end: '2026-12-31', semester2_end: '2027-06-30' });
  const bu = data.groups.find(g => g.name === 'БУ-21');
  const econ = data.curriculum.find(c => c.group_id === bu.id && data.subjects.find(s => s.id === c.subject_id).name === 'Экономика организации');
  econ.semester = 2;
  call('POST', '/auto', { dates: WEEK, group_ids: [bu.id] });
  assert.ok(!data.lessons.some(l => WEEK.includes(l.date) && l.curriculum_id === econ.id));
});

test('проверка дня: меньше минимума и не с 1-й пары — предупреждения', () => {
  const { data, call } = setup();
  const bu = data.groups.find(g => g.name === 'БУ-21');
  const item = data.curriculum.find(c => c.group_id === bu.id && data.subjects.find(s => s.id === c.subject_id).name === 'Бухгалтерский учёт');
  call('PUT', '/day/2026-11-02/cell', { group_id: bu.id, pair: 2, lessons: [{ curriculum_id: item.id, kind: 'lecture' }] });
  const w = validateDay(data, '2026-11-02').filter(i => i.level === 'warning').map(i => i.text).join(' | ');
  assert.match(w, /1 пара за день, нужно не меньше 4/);
  assert.match(w, /начинаются с 2-й/);
});
