import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../js/store.js';
import { validateDay, computeProgress, teacherFor, unitKey } from '../js/logic.js';
import { groupReadiness } from '../js/autoschedule.js';

const demo = JSON.parse(fs.readFileSync(new URL('./fixtures/demo.json', import.meta.url), 'utf8'));
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

function setup() {
  const data = structuredClone(demo);
  const st = createStore(data);
  const call = (method, path, body = {}) => st.handle(method, path, new URLSearchParams(), body, { admin: true });
  const g = name => data.groups.find(x => x.name === name);
  const t = name => data.teachers.find(x => x.short_name === name);
  const item = (group, subject) => data.curriculum.find(c => c.group_id === g(group).id && data.subjects.find(s => s.id === c.subject_id).name === subject);
  return { data, call, g, t, item };
}

test('разные преподаватели для лекций, практических и подгрупп', () => {
  const { data, call, g, t, item } = setup();
  const prog = item('ИС-21', 'Программирование');
  const [s1, s2] = g('ИС-21').subgroups.map(x => x.id);
  call('PUT', `/curriculum/${prog.id}`, { ...prog, teachers: { lecture: t('Иванов И.И.').id, [`lab:${s2}`]: t('Козлов Д.А.').id } });
  assert.equal(teacherFor(prog, 'lecture'), t('Иванов И.И.').id);
  assert.equal(teacherFor(prog, 'lab', s1), t('Петрова А.С.').id, 'П1 — основной преподаватель');
  assert.equal(teacherFor(prog, 'lab', s2), t('Козлов Д.А.').id);

  // ячейка без явного преподавателя берёт назначенного
  call('PUT', '/day/2026-11-02/cell', { group_id: g('ИС-21').id, pair: 1, lessons: [{ subgroup_id: s2, curriculum_id: prog.id, kind: 'lab' }] });
  assert.equal(data.lessons.find(l => l.date === '2026-11-02' && l.subgroup_id === s2).teacher_id, t('Козлов Д.А.').id);

  // нагрузка: лабораторные П2 записаны на Козлова
  const rep = call('GET', '/report/teachers');
  const koz = rep.rows.find(r => r.name === 'Козлов Д.А.');
  assert.ok(koz.items.some(i => i.subject === 'Программирование' && i.subgroup === 'Подгруппа 2'));
  assert.equal(koz.planned_h, prog.h_lab);

  // удалили преподавателя — назначение пропало, остался основной
  call('DELETE', `/teachers/${t('Козлов Д.А.').id}`);
  assert.equal(teacherFor(prog, 'lab', s2), prog.teacher_id);
});

test('уже проведённые часы уменьшают остаток', () => {
  const { data, call, item } = setup();
  const math = item('БУ-21', 'Математика');
  const key = unitKey(math.id, 'lecture', 0);
  const before = computeProgress(data)[key] ?? 0;
  call('PUT', `/curriculum/${math.id}`, { ...math, done_lecture: 20 });
  assert.equal(computeProgress(data)[key], before + 10, '20 ч = 10 пар');
  const left = groupReadiness(data, math.group_id).pairsLeft;
  call('PUT', `/curriculum/${math.id}`, { ...math, done_lecture: 0 });
  assert.equal(groupReadiness(data, math.group_id).pairsLeft, left + 10);
});

test('у преподавателя не больше 4 пар в день', () => {
  const { data, call, g, t, item } = setup();
  const eng = name => item(name, 'Иностранный язык');
  const date = '2026-11-02';
  // 5 пар английского у Смирновой в разных группах/подгруппах
  call('PUT', `/day/${date}/cell`, { group_id: g('БУ-21').id, pair: 1, lessons: [{ curriculum_id: eng('БУ-21').id, kind: 'practice' }] });
  const [a1, a2] = g('ИС-21').subgroups.map(x => x.id);
  for (const [pair, sg] of [[2, a1], [3, a2], [4, a1], [5, a2]]) {
    call('PUT', `/day/${date}/cell`, { group_id: g('ИС-21').id, pair, lessons: [{ subgroup_id: sg, curriculum_id: eng('ИС-21').id, kind: 'practice', room_id: 1 }] });
  }
  assert.ok(validateDay(data, date).some(i => i.level === 'error' && i.text.includes('Смирнова Е.В.: 5 пар')));
});

test('автосоставление: с 1-й пары, у подгрупп одинаковые предметы в разном порядке, лимит преподавателя', () => {
  const { data, call } = setup();
  const r = call('POST', '/auto', { dates: WEEK, group_ids: data.groups.map(x => x.id) });
  const lateInReport = new Set(r.report.filter(x => /начинается/.test(x.note)).map(x => `${x.date} ${x.group}`));
  assert.ok(lateInReport.size <= 2, `не с 1-й пары: ${[...lateInReport]}`);
  for (const d of WEEK) {
    assert.deepEqual(validateDay(data, d).filter(i => i.level === 'error').map(i => i.text), [], d);
    for (const grp of data.groups) {
      const ls = data.lessons.filter(l => l.date === d && l.group_id === grp.id);
      if (!ls.length) continue;
      // С 1-й пары; иначе — только если в отчёте сказано, что на 1-ю пару никто не свободен
      if (Math.min(...ls.map(l => l.pair)) !== 1) assert.ok(lateInReport.has(`${d} ${grp.name}`), `${d} ${grp.name}: не с 1-й пары без объяснения`);
      if (grp.subgroups.length === 2) {
        const subj = sg => ls.filter(l => !l.subgroup_id || l.subgroup_id === sg.id).map(l => `${l.curriculum_id}${l.kind}`).sort().join();
        assert.equal(subj(grp.subgroups[0]), subj(grp.subgroups[1]), `${d} ${grp.name}: разные предметы у подгрупп`);
      }
    }
    const perTeacher = new Map();
    for (const l of data.lessons.filter(x => x.date === d)) {
      if (!perTeacher.has(l.teacher_id)) perTeacher.set(l.teacher_id, new Set());
      perTeacher.get(l.teacher_id).add(l.pair);
    }
    for (const [tid, pairs] of perTeacher) assert.ok(pairs.size <= 4, `${d}: у преподавателя ${tid} ${pairs.size} пар`);
  }
});

test('сокращение предмета сохраняется', () => {
  const { data, call } = setup();
  const s = data.subjects.find(x => x.name === 'Иностранный язык');
  call('PUT', `/subjects/${s.id}`, { name: s.name, short: 'Англ. яз.', room_type: '' });
  assert.equal(data.subjects.find(x => x.id === s.id).short, 'Англ. яз.');
});
