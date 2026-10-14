import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from './logic.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  building TEXT NOT NULL DEFAULT '',
  capacity INTEGER,
  type     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS teachers (
  id         INTEGER PRIMARY KEY,
  full_name  TEXT NOT NULL,
  short_name TEXT NOT NULL,
  room_id    INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS availability (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL,
  pair_from  INTEGER NOT NULL,
  pair_to    INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, weekday)
);
CREATE TABLE IF NOT EXISTS absences (
  id         INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  date_from  TEXT NOT NULL,
  date_to    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS study_groups (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  specialty TEXT NOT NULL DEFAULT '',
  course    INTEGER,
  size      INTEGER
);
CREATE TABLE IF NOT EXISTS subgroups (
  id       INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  name     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subjects (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  room_type TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS curriculum (
  id             INTEGER PRIMARY KEY,
  group_id       INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id     INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  semester       INTEGER,
  h_lecture      INTEGER NOT NULL DEFAULT 0,
  h_practice     INTEGER NOT NULL DEFAULT 0,
  h_lab          INTEGER NOT NULL DEFAULT 0,
  split_practice INTEGER NOT NULL DEFAULT 0,
  split_lab      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schedule_days (
  date        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'draft',
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
  id            INTEGER PRIMARY KEY,
  date          TEXT NOT NULL,
  pair          INTEGER NOT NULL,
  group_id      INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  subgroup_id   INTEGER REFERENCES subgroups(id) ON DELETE CASCADE,
  curriculum_id INTEGER NOT NULL REFERENCES curriculum(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  teacher_id    INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  room_id       INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS lessons_date ON lessons(date);
CREATE INDEX IF NOT EXISTS lessons_curriculum ON lessons(curriculum_id);
CREATE TABLE IF NOT EXISTS change_log (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  date    TEXT,
  action  TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  if (!seeded) seed(db);
  return db;
}

// Демонстрационные данные, чтобы приложение можно было сразу попробовать.
function seed(db) {
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
    }

    const room = (name, type, capacity) => ins('INSERT INTO rooms (name, building, capacity, type) VALUES (?, ?, ?, ?)', name, 'Главный', capacity, type);
    const r101 = room('101', 'Лекционная', 30);
    const r214 = room('214', 'Компьютерный класс', 25);
    const r215 = room('215', 'Компьютерный класс', 15);
    const r216 = room('216', 'Компьютерный класс', 15);
    const r305 = room('305', 'Лекционная', 35);
    room('110', 'Лаборатория', 20);
    const gym = room('Спортзал', 'Спортзал', 60);

    const teacher = (full, short, roomId, avail) => {
      const id = ins('INSERT INTO teachers (full_name, short_name, room_id) VALUES (?, ?, ?)', full, short, roomId);
      for (const [wd, from, to] of avail) {
        db.prepare('INSERT INTO availability (teacher_id, weekday, pair_from, pair_to) VALUES (?, ?, ?, ?)').run(id, wd, from, to);
      }
      return id;
    };
    const weekdays = (from, to, days = [1, 2, 3, 4, 5]) => days.map(d => [d, from, to]);
    const ivanov = teacher('Иванов Иван Иванович', 'Иванов И.И.', null, [[1, 2, 3], [3, 1, 4], [4, 3, 6], [5, 1, 6]]);
    const petrova = teacher('Петрова Анна Сергеевна', 'Петрова А.С.', r214, weekdays(1, 6));
    const kozlov = teacher('Козлов Дмитрий Андреевич', 'Козлов Д.А.', r215, weekdays(1, 6));
    const sidorov = teacher('Сидоров Пётр Петрович', 'Сидоров П.П.', gym, weekdays(1, 6, [1, 2, 3, 4, 5, 6]));
    const smirnova = teacher('Смирнова Елена Викторовна', 'Смирнова Е.В.', null, weekdays(1, 6));
    const orlova = teacher('Орлова Мария Игоревна', 'Орлова М.И.', r305, weekdays(1, 4));
    const volkov = teacher('Волков Алексей Николаевич', 'Волков А.Н.', null, weekdays(2, 6, [1, 2, 3, 4, 5, 6]));

    const subject = (name, roomType = '') => ins('INSERT INTO subjects (name, room_type) VALUES (?, ?)', name, roomType);
    const math = subject('Математика');
    const prog = subject('Программирование', 'Компьютерный класс');
    const pe = subject('Физическая культура', 'Спортзал');
    const eng = subject('Иностранный язык');
    const dbs = subject('Базы данных', 'Компьютерный класс');
    const acc = subject('Бухгалтерский учёт');
    const econ = subject('Экономика организации');

    const group = (name, specialty, course, size, subgroups) => {
      const id = ins('INSERT INTO study_groups (name, specialty, course, size) VALUES (?, ?, ?, ?)', name, specialty, course, size);
      const subs = subgroups.map(s => ins('INSERT INTO subgroups (group_id, name) VALUES (?, ?)', id, s));
      return { id, subs };
    };
    const is = '09.02.07 Информационные системы и программирование';
    const is21 = group('ИС-21', is, 2, 24, ['Подгруппа 1', 'Подгруппа 2']);
    const is22 = group('ИС-22', is, 2, 22, ['Подгруппа 1', 'Подгруппа 2']);
    const bu21 = group('БУ-21', '38.02.01 Экономика и бухгалтерский учёт', 2, 28, []);

    const plan = (g, subj, t, sem, lec, pr, lab, splitPr = 0, splitLab = 0) =>
      ins(`INSERT INTO curriculum (group_id, subject_id, teacher_id, semester, h_lecture, h_practice, h_lab, split_practice, split_lab)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, g.id, subj, t, sem, lec, pr, lab, splitPr, splitLab);
    const p = {};
    for (const g of [is21, is22]) {
      p[g.id] = {
        math: plan(g, math, ivanov, 1, 80, 40, 0),
        prog: plan(g, prog, petrova, 1, 60, 0, 100, 0, 1),
        pe: plan(g, pe, sidorov, 1, 0, 72, 0),
        eng: plan(g, eng, smirnova, 1, 0, 72, 0, 1, 0),
        dbs: plan(g, dbs, volkov, 1, 40, 0, 60, 0, 1),
      };
    }
    p[bu21.id] = {
      math: plan(bu21, math, ivanov, 1, 60, 30, 0),
      acc: plan(bu21, acc, orlova, 1, 80, 60, 0),
      econ: plan(bu21, econ, orlova, 1, 60, 40, 0),
      pe: plan(bu21, pe, sidorov, 1, 0, 72, 0),
      eng: plan(bu21, eng, smirnova, 1, 0, 72, 0),
    };

    // Черновик на ближайший учебный день: у ИС-21 подгруппы учатся 1–3 и 4–6 парами.
    const d = new Date();
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    db.prepare("INSERT INTO schedule_days (date, status) VALUES (?, 'draft')").run(date);
    const lesson = (pair, g, sub, cid, kind, t, r) =>
      ins(`INSERT INTO lessons (date, pair, group_id, subgroup_id, curriculum_id, kind, teacher_id, room_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, date, pair, g.id, sub, cid, kind, t, r);
    const [s1, s2] = is21.subs;
    lesson(1, is21, s1, p[is21.id].prog, 'lab', petrova, r214);
    lesson(2, is21, s1, p[is21.id].dbs, 'lab', volkov, r216);
    lesson(3, is21, s1, p[is21.id].eng, 'practice', smirnova, r101);
    lesson(4, is21, s2, p[is21.id].prog, 'lab', kozlov, r215);
    lesson(5, is21, s2, p[is21.id].dbs, 'lab', volkov, r216);
    lesson(6, is21, s2, p[is21.id].eng, 'practice', smirnova, r101);
    lesson(2, is22, null, p[is22.id].prog, 'lecture', petrova, r214);
    lesson(3, is22, null, p[is22.id].pe, 'practice', sidorov, gym);
    lesson(4, is22, null, p[is22.id].prog, 'lecture', petrova, r214);
    lesson(1, bu21, null, p[bu21.id].acc, 'lecture', orlova, r305);
    lesson(2, bu21, null, p[bu21.id].acc, 'practice', orlova, r305);
    lesson(3, bu21, null, p[bu21.id].econ, 'lecture', orlova, r305);

    db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', 'true')").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
