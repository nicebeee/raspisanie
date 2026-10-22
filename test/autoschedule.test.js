import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../js/store.js';
import { validateDay, settingsOf } from '../js/logic.js';
import { groupReadiness } from '../js/autoschedule.js';

const demo = JSON.parse(fs.readFileSync(new URL('./fixtures/demo.json', import.meta.url), 'utf8'));
const NEXT_WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];

function setup() {
  const data = structuredClone(demo);
  const st = createStore(data);
  const call = (method, path, body = {}) => st.handle(method, path, new URLSearchParams(), body, { admin: true });
  return { data, call, all: data.groups.map(g => g.id) };
}

test('составленная неделя проходит все проверки без ошибок', () => {
  const { data, call, all } = setup();
  const r = call('POST', '/auto', { dates: NEXT_WEEK, group_ids: all });
  assert.ok(r.created > 40, `поставлено ${r.created}`);
  for (const d of NEXT_WEEK) {
    const errors = validateDay(data, d).filter(i => i.level === 'error');
    assert.deepEqual(errors.map(e => e.text), [], d);
  }
});

test('лимит пар в день и «один предмет — не больше N» соблюдаются', () => {
  const { data, call, all } = setup();
  call('POST', '/auto', { dates: NEXT_WEEK, group_ids: all, pairs_per_day: 3, max_same: 1 });
  for (const d of NEXT_WEEK) {
    for (const g of data.groups) {
      const streams = g.subgroups.length ? g.subgroups.map(s => s.id) : [0];
      for (const sid of streams) {
        const ls = data.lessons.filter(l => l.date === d && l.group_id === g.id && (!l.subgroup_id || l.subgroup_id === sid));
        assert.ok(ls.length <= 3, `${d} ${g.name} ${sid}: ${ls.length} пар`);
        const perSubject = new Map();
        for (const l of ls) {
          const subj = data.curriculum.find(c => c.id === l.curriculum_id).subject_id;
          perSubject.set(subj, (perSubject.get(subj) ?? 0) + 1);
        }
        assert.ok([...perSubject.values()].every(n => n <= 1), `${d} ${g.name}: предмет повторяется`);
      }
    }
  }
});

test('не ставит больше пар, чем осталось по плану', () => {
  const { data, call } = setup();
  const bu = data.groups.find(g => g.name === 'БУ-21');
  data.lessons = data.lessons.filter(l => l.group_id !== bu.id);
  // У каждого предмета: 2 пары лекций и 1 пара практики
  for (const c of data.curriculum.filter(x => x.group_id === bu.id)) Object.assign(c, { h_lecture: 4, h_practice: 2, h_lab: 0 });
  const items = data.curriculum.filter(x => x.group_id === bu.id);
  const r = call('POST', '/auto', { dates: NEXT_WEEK, group_ids: [bu.id] });
  for (const c of items) {
    const n = kind => data.lessons.filter(l => l.curriculum_id === c.id && l.kind === kind).length;
    assert.ok(n('lecture') <= 2 && n('practice') <= 1, `${c.id}: лек ${n('lecture')}, пр ${n('practice')}`);
  }
  assert.ok(r.created <= items.length * 3 && r.created > 0, `поставлено ${r.created}`);
  assert.equal(groupReadiness(data, bu.id).pairsLeft, items.length * 3 - r.created);
});

test('заполненные и утверждённые дни не трогает', () => {
  const { data, call, all } = setup();
  const approvedDay = '2026-10-14'; // из демо-недели, утверждён
  const before = data.lessons.filter(l => l.date === approvedDay).length;
  const r = call('POST', '/auto', { dates: [approvedDay], group_ids: all });
  assert.equal(r.created, 0);
  assert.equal(data.lessons.filter(l => l.date === approvedDay).length, before);

  const day = '2026-10-19';
  call('POST', '/auto', { dates: [day], group_ids: all });
  const count = data.lessons.filter(l => l.date === day).length;
  const again = call('POST', '/auto', { dates: [day], group_ids: all });
  assert.equal(again.created, 0, 'повторный запуск не добавляет пар');
  assert.equal(data.lessons.filter(l => l.date === day).length, count);
});

test('без преподавателя группу не составить, пока его не укажут', () => {
  const { data, call } = setup();
  const is21 = data.groups.find(g => g.name === 'ИС-21');
  const item = data.curriculum.find(c => c.group_id === is21.id);
  const teacherId = item.teacher_id;
  item.teacher_id = null;
  const ready = groupReadiness(data, is21.id);
  assert.equal(ready.ready, false);
  assert.equal(ready.missing.length, 1);
  assert.throws(() => call('POST', '/auto', { dates: ['2026-10-19'], group_ids: [is21.id] }), /укажите преподавателей.*ИС-21/);
  call('PUT', `/curriculum/${item.id}`, { ...item, teacher_id: teacherId });
  assert.ok(call('POST', '/auto', { dates: ['2026-10-19'], group_ids: [is21.id] }).created > 0);
});

test('подгруппы: у каждой пары подряд, преподаватель не ведёт две подгруппы сразу', () => {
  const { data, call } = setup();
  const is21 = data.groups.find(g => g.name === 'ИС-21');
  call('POST', '/auto', { dates: NEXT_WEEK.slice(0, 5), group_ids: [is21.id] });
  for (const d of NEXT_WEEK.slice(0, 5)) {
    for (const sg of is21.subgroups) {
      const pairs = data.lessons.filter(l => l.date === d && l.group_id === is21.id && (!l.subgroup_id || l.subgroup_id === sg.id))
        .map(l => l.pair).sort((a, b) => a - b);
      if (pairs.length) assert.equal(pairs[pairs.length - 1] - pairs[0] + 1, pairs.length, `${d} ${sg.name}: окно ${pairs}`);
    }
  }
  const keys = new Set();
  for (const l of data.lessons.filter(x => x.status === 'active' && x.teacher_id)) {
    const k = `${l.date}|${l.pair}|${l.teacher_id}`;
    assert.ok(!keys.has(k), `накладка преподавателя ${k}`);
    keys.add(k);
  }
});
