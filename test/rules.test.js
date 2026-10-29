import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../js/store.js';
import { validateDay, computeProgress } from '../js/logic.js';

const demo = JSON.parse(fs.readFileSync(new URL('./fixtures/demo.json', import.meta.url), 'utf8'));
// В демо-неделе у некоторых групп по две пары одного предмета в день — эти тесты проверяют другие правила.
demo.settings = { ...demo.settings, max_same_subject: 2 };
const ADMIN = { admin: true };
const GUEST = { admin: false };

// Каждый тест работает на своей копии демо-данных.
function setup() {
  const data = structuredClone(demo);
  const st = createStore(data);
  const call = (method, path, body = {}, ctx = ADMIN) => st.handle(method, path, new URLSearchParams(), body, ctx);
  const date = Object.keys(data.days).sort()[2];
  const id = (list, key, value) => data[list].find(x => x[key] === value).id;
  const is21 = data.groups.find(g => g.name === 'ИС-21');
  const subs = is21.subgroups.map(s => s.id);
  const plan = name => data.curriculum.find(c => c.group_id === is21.id && c.subject_id === id('subjects', 'name', name)).id;
  call('POST', `/day/${date}/unapprove`);
  const cell = (pair, lessons) => call('PUT', `/day/${date}/cell`, { group_id: is21.id, pair, lessons });
  const errors = () => validateDay(st.data, date).filter(i => i.level === 'error').map(i => i.text);
  return { data: st.data, st, call, date, is21, subs, plan, cell, errors, id };
}

test('демо-неделя (подгруппы 1–3 и 4–6) проходит проверку', () => {
  for (const date of Object.keys(demo.days)) {
    assert.deepEqual(validateDay(demo, date).filter(i => i.level === 'error'), [], date);
  }
});

test('окно у подгруппы — ошибка', () => {
  const { cell, errors } = setup();
  cell(5, []); // у 2-й подгруппы остаются 4 и 6 пары
  assert.ok(errors().some(e => e.includes('Подгруппа 2') && e.includes('окно на 5-й')));
});

test('больше максимума пар у подгруппы — ошибка (максимум 4 в настройках)', () => {
  const { cell, errors, subs, plan, id, data } = setup();
  data.settings = { ...data.settings, min_pairs: 1, max_pairs: 4 };
  cell(4, [
    { subgroup_id: subs[0], curriculum_id: plan('Иностранный язык'), kind: 'practice', room_id: id('rooms', 'name', '305') },
    { subgroup_id: subs[1], curriculum_id: plan('Программирование'), kind: 'lab', teacher_id: id('teachers', 'short_name', 'Козлов Д.А.') },
  ]);
  cell(5, [
    { subgroup_id: subs[0], curriculum_id: plan('Математика'), kind: 'practice', room_id: id('rooms', 'name', '110') },
    { subgroup_id: subs[1], curriculum_id: plan('Базы данных'), kind: 'lab', room_id: id('rooms', 'name', '216') },
  ]);
  const errs = errors();
  assert.ok(errs.some(e => e.includes('Подгруппа 1') && e.includes('5 пар')), errs.join('\n'));
});

test('общая пара группы и пара подгруппы в одно время — запрещено', () => {
  const { cell, subs, plan } = setup();
  assert.throws(() => cell(1, [
    { curriculum_id: plan('Математика'), kind: 'lecture' },
    { subgroup_id: subs[1], curriculum_id: plan('Программирование'), kind: 'lab' },
  ]), /Общая пара/);
});

test('лабораторная, которая делится на подгруппы, для всей группы — ошибка', () => {
  const { data, date, is21, plan, errors } = setup();
  data.lessons = data.lessons.filter(l => !(l.date === date && l.group_id === is21.id));
  data.lessons.push({ id: 9999, date, pair: 1, group_id: is21.id, subgroup_id: null, curriculum_id: plan('Программирование'), kind: 'lab', teacher_id: null, room_id: null, status: 'active' });
  assert.ok(errors().some(e => e.includes('проводится по подгруппам')));
});

test('преподаватель вне своих часов и в чужой аудитории — ошибки', () => {
  const { data, date, errors, id } = setup();
  const petrova = data.teachers.find(t => t.short_name === 'Петрова А.С.');
  for (const a of petrova.availability) a.pair_from = 3;
  data.lessons.find(l => l.date === date && l.teacher_id === petrova.id && l.pair === 1).room_id = id('rooms', 'name', '101');
  const errs = errors();
  assert.ok(errs.some(e => e.includes('Петрова А.С. доступен только с 3')), errs.join('\n'));
  assert.ok(errs.some(e => e.includes('закреплённой аудитории 214')), errs.join('\n'));
});

test('отсутствие преподавателя — ошибка', () => {
  const { call, errors, date, id } = setup();
  call('POST', '/absences', { teacher_id: id('teachers', 'short_name', 'Орлова М.И.'), date_from: date, date_to: date });
  assert.ok(errors().some(e => e.includes('Орлова М.И. отсутствует')));
});

test('преподаватель с закреплённой аудиторией ставится в неё автоматически', () => {
  const { cell, subs, plan, date, data, id } = setup();
  cell(1, [{ subgroup_id: subs[0], curriculum_id: plan('Программирование'), kind: 'lab', room_id: id('rooms', 'name', '101') }]);
  const l = data.lessons.find(x => x.date === date && x.pair === 1 && x.subgroup_id === subs[0]);
  assert.equal(l.room_id, id('rooms', 'name', '214'));
});

test('остаток пар списывается только после утверждения, отмена возвращает пару', () => {
  const { call, data, date, subs, plan } = setup();
  const key = `${plan('Программирование')}|lab|${subs[0]}`;
  assert.equal(computeProgress(data)[key], 4); // остальные 4 дня демо-недели утверждены
  call('POST', `/day/${date}/approve`);
  assert.equal(computeProgress(data)[key], 5);
  const lesson = data.lessons.find(l => l.date === date && l.pair === 1 && l.subgroup_id === subs[0]);
  call('POST', `/lessons/${lesson.id}/cancel`);
  assert.equal(computeProgress(data)[key], 4);
});

test('утвердить расписание с ошибками нельзя', () => {
  const { call, cell, date } = setup();
  cell(5, []);
  assert.throws(() => call('POST', `/day/${date}/approve`), /Нельзя утвердить/);
});

test('удаление предмета убирает его из плана и расписания', () => {
  const { call, data, id } = setup();
  const subj = id('subjects', 'name', 'Базы данных');
  call('DELETE', `/subjects/${subj}`);
  const left = new Set(data.curriculum.map(c => c.id));
  assert.ok(data.curriculum.every(c => c.subject_id !== subj));
  assert.ok(data.lessons.every(l => left.has(l.curriculum_id)));
});

test('гость видит только утверждённое расписание и не может ничего менять', () => {
  const { st, call, date, is21 } = setup();
  const view = (drafts, ctx) => st.handle('GET', '/view', new URLSearchParams({ type: 'group', id: is21.id, from: date, to: date, drafts }), {}, ctx);
  assert.throws(() => call('GET', `/day/${date}`, {}, GUEST), /Войдите/);
  assert.throws(() => call('DELETE', `/day/${date}`, {}, GUEST), /Войдите/);
  assert.equal(view('1', GUEST).lessons.length, 0, 'черновик гостю не показывается');
  assert.equal(view('1', ADMIN).lessons.length, 6);
  call('POST', `/day/${date}/approve`);
  assert.equal(view('0', GUEST).lessons.length, 6);
});

test('удаление группы убирает её план, расписание и предметы, которых нет у других групп', () => {
  const { call, data, id } = setup();
  call('POST', `/groups/${id('groups', 'name', 'ИС-22')}/subjects`, { name: 'Только у ИС-22' });
  const bu = data.groups.find(g => g.name === 'БУ-21');
  call('POST', `/groups/${bu.id}/subjects`, { name: 'Общий предмет' });
  const is22 = id('groups', 'name', 'ИС-22');
  call('POST', `/groups/${is22}/subjects`, { name: 'общий предмет' }); // тот же предмет, другой регистр
  call('DELETE', `/groups/${is22}`);

  assert.ok(!data.groups.some(g => g.id === is22));
  assert.ok(!data.curriculum.some(c => c.group_id === is22));
  assert.ok(!data.lessons.some(l => l.group_id === is22));
  const names = data.subjects.map(s => s.name);
  assert.ok(!names.includes('Только у ИС-22'), 'предмет только этой группы удалён');
  assert.ok(names.includes('Общий предмет'), 'предмет, который есть у БУ-21, остался');
  assert.ok(names.includes('Программирование'), 'предмет есть у ИС-21 — остался');
  assert.ok(data.curriculum.every(c => data.subjects.some(s => s.id === c.subject_id)));
});

test('предмет группы: добавление с часами, повтор запрещён, «Убрать» удаляет ненужный предмет', () => {
  const { call, data, is21 } = setup();
  call('POST', `/groups/${is21.id}/subjects`, { name: 'Черчение', plan: { h_practice: 68, semester: 2 } });
  const subj = data.subjects.find(s => s.name === 'Черчение');
  const item = data.curriculum.find(c => c.group_id === is21.id && c.subject_id === subj.id);
  assert.deepEqual([item.h_practice, item.semester, item.teacher_id], [68, 2, null]);
  assert.throws(() => call('POST', `/groups/${is21.id}/subjects`, { name: 'черчение' }), /уже есть/);
  call('DELETE', `/curriculum/${item.id}`);
  assert.ok(!data.subjects.some(s => s.name === 'Черчение'));
});

test('предметы без групп (остатки старых удалений) убираются', () => {
  const data = structuredClone(demo);
  data.subjects.push({ id: 9001, name: 'Сирота', room_type: '' });
  const st = createStore(data);
  assert.equal(st.pruneUnusedSubjects(), 1);
  assert.ok(!data.subjects.some(s => s.name === 'Сирота'));
  assert.equal(st.pruneUnusedSubjects(), 0);
});

test('один предмет у группы в день — не больше одного раза (лекция и практика тоже считаются)', () => {
  const data = structuredClone(demo);
  data.settings = { ...data.settings, max_same_subject: 1 };
  const st = createStore(data);
  const call = (method, path, body = {}) => st.handle(method, path, new URLSearchParams(), body, { admin: true });
  const bu = data.groups.find(g => g.name === 'БУ-21');
  const math = data.curriculum.find(c => c.group_id === bu.id && data.subjects.find(s => s.id === c.subject_id).name === 'Математика');
  const date = '2026-11-02';
  call('PUT', `/day/${date}/cell`, { group_id: bu.id, pair: 1, lessons: [{ curriculum_id: math.id, kind: 'lecture', room_id: 1 }] });
  call('PUT', `/day/${date}/cell`, { group_id: bu.id, pair: 2, lessons: [{ curriculum_id: math.id, kind: 'practice', room_id: 1 }] });
  assert.ok(validateDay(data, date).some(i => i.level === 'error' && i.text.includes('«Математика» 2 раза за день')));

  // автосоставление на неделю: ни одного повтора предмета в день
  call('POST', '/auto', { dates: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], group_ids: data.groups.map(g => g.id) });
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
    const repeats = validateDay(data, d).filter(i => i.text.includes('раза за день'));
    assert.deepEqual(repeats.map(i => i.text), [], d);
  }
});
