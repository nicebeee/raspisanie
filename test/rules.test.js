import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createApi } from '../lib/api.js';
import { createAuth } from '../lib/auth.js';
import { validateDay, computeProgress } from '../lib/logic.js';

// Каждый тест работает на свежей базе с демо-данными в памяти.
function setup() {
  const db = openDb(':memory:');
  const raw = createApi(db);
  const api = { handle: (m, p, q, b) => raw.handle(m, p, q, b, { admin: true }) };
  const date = db.prepare('SELECT date FROM schedule_days').get().date;
  const id = (table, col, value) => db.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).get(value).id;
  const is21 = id('study_groups', 'name', 'ИС-21');
  const subs = db.prepare('SELECT id FROM subgroups WHERE group_id = ? ORDER BY name').all(is21).map(r => r.id);
  const plan = name => db.prepare('SELECT c.id FROM curriculum c JOIN subjects s ON s.id = c.subject_id WHERE c.group_id = ? AND s.name = ?')
    .get(is21, name).id;
  const cell = (pair, lessons) => api.handle('PUT', `/day/${date}/cell`, null, { group_id: is21, pair, lessons });
  const errors = () => validateDay(db, date).filter(i => i.level === 'error').map(i => i.text);
  return { db, api, date, is21, subs, plan, cell, errors, id };
}

test('демо-день (подгруппы 1–3 и 4–6) проходит проверку', () => {
  const { errors } = setup();
  assert.deepEqual(errors(), []);
});

test('окно у подгруппы — ошибка', () => {
  const { cell, errors } = setup();
  cell(5, []); // у 2-й подгруппы остаются 4 и 6 пары
  assert.ok(errors().some(e => e.includes('Подгруппа 2') && e.includes('окно на 5-й')));
});

test('больше 4 пар у подгруппы — ошибка', () => {
  const { cell, errors, subs, plan, id } = setup();
  // 1-я подгруппа: 1–3 уже есть, добавляем 4 и 5
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
  const { db, date, is21, plan, errors } = setup();
  db.prepare('DELETE FROM lessons WHERE group_id = ?').run(is21);
  db.prepare("INSERT INTO lessons (date, pair, group_id, curriculum_id, kind) VALUES (?, 1, ?, ?, 'lab')").run(date, is21, plan('Программирование'));
  assert.ok(errors().some(e => e.includes('проводится по подгруппам')));
});

test('преподаватель вне своих часов и в чужой аудитории — ошибки', () => {
  const { db, date, errors, id } = setup();
  const petrova = id('teachers', 'short_name', 'Петрова А.С.');
  db.prepare('UPDATE availability SET pair_from = 3 WHERE teacher_id = ?').run(petrova);
  db.prepare('UPDATE lessons SET room_id = ? WHERE date = ? AND teacher_id = ? AND pair = 1').run(id('rooms', 'name', '101'), date, petrova);
  const errs = errors();
  assert.ok(errs.some(e => e.includes('Петрова А.С. доступен только с 3')), errs.join('\n'));
  assert.ok(errs.some(e => e.includes('закреплённой аудитории 214')), errs.join('\n'));
});

test('преподаватель с закреплённой аудиторией ставится в неё автоматически', () => {
  const { cell, subs, plan, date, db, id } = setup();
  cell(1, [{ subgroup_id: subs[0], curriculum_id: plan('Программирование'), kind: 'lab', room_id: id('rooms', 'name', '101') }]);
  const l = db.prepare('SELECT room_id FROM lessons WHERE date = ? AND pair = 1 AND subgroup_id = ?').get(date, subs[0]);
  assert.equal(l.room_id, id('rooms', 'name', '214'));
});

test('остаток пар списывается только после утверждения, отмена возвращает пару', () => {
  const { api, db, date, subs, plan } = setup();
  const key = `${plan('Программирование')}|lab|${subs[0]}`;
  assert.equal(computeProgress(db)[key], undefined);
  api.handle('POST', `/day/${date}/approve`, null, {});
  assert.equal(computeProgress(db)[key], 1);
  const lesson = db.prepare('SELECT id FROM lessons WHERE date = ? AND pair = 1 AND subgroup_id = ?').get(date, subs[0]);
  api.handle('POST', `/lessons/${lesson.id}/cancel`, null, {});
  assert.equal(computeProgress(db)[key], undefined);
});

test('утвердить расписание с ошибками нельзя', () => {
  const { api, cell, date } = setup();
  cell(5, []);
  assert.throws(() => api.handle('POST', `/day/${date}/approve`, null, {}), /Нельзя утвердить/);
});

test('гость видит только утверждённое расписание и не может ничего менять', () => {
  const db = openDb(':memory:');
  const api = createApi(db);
  const guest = { admin: false };
  const date = db.prepare('SELECT date FROM schedule_days').get().date;
  const gid = db.prepare("SELECT id FROM study_groups WHERE name = 'ИС-21'").get().id;
  const view = drafts => api.handle('GET', '/view', new URLSearchParams({ type: 'group', id: gid, from: date, to: date, drafts }), {}, guest);

  assert.throws(() => api.handle('GET', '/bootstrap', null, {}, guest), /Войдите/);
  assert.throws(() => api.handle('GET', `/day/${date}`, null, {}, guest), /Войдите/);
  assert.throws(() => api.handle('DELETE', `/day/${date}`, null, {}, guest), /Войдите/);
  assert.equal(view('1').lessons.length, 0, 'черновик гостю не показывается');

  const pub = api.handle('GET', '/public/bootstrap', null, {}, guest);
  assert.equal(pub.teachers[0].absences, undefined);
  assert.equal(JSON.stringify(pub).includes('admin_password'), false);

  api.handle('POST', `/day/${date}/approve`, null, {}, { admin: true });
  assert.equal(view('0').lessons.length, 6);
});

test('вход: верный пароль даёт сессию, неверный — нет', () => {
  const db = openDb(':memory:');
  const auth = createAuth(db);
  auth.init('секретный-пароль');
  assert.throws(() => auth.login('не тот', '1.1.1.1'), /Неверный пароль/);
  const s = auth.login('секретный-пароль', '1.1.1.1');
  assert.equal(auth.check(s.token), true);
  auth.logout(s.token);
  assert.equal(auth.check(s.token), false);
  assert.equal(JSON.stringify(createApi(db).handle('GET', '/bootstrap', null, {}, { admin: true }).settings).includes('admin_password'), false);
});
