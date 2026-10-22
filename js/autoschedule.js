// Автосоставление расписания: жадная расстановка пар по группам и дням.
// Соблюдает правила из logic.js: до N пар подряд без окон (для каждой подгруппы),
// доступность и занятость преподавателей, закреплённые аудитории, деление на подгруппы.
// В первую очередь ставятся предметы, по которым осталась наибольшая доля часов.
import { KINDS, isSplitKind, settingsOf, unitKey, weekdayOf } from './logic.js';

// Сколько пар уже стоит по каждой единице плана — с учётом черновиков, чтобы не поставить лишнего.
function usedCounts(data) {
  const out = new Map();
  for (const l of data.lessons) {
    if (l.status !== 'active') continue;
    const k = unitKey(l.curriculum_id, l.kind, l.subgroup_id);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

const plannedPairs = (item, kind, hpp) => Math.ceil((item['h_' + kind] ?? 0) / hpp);

// Готова ли группа к автосоставлению: у каждого предмета, по которому остались часы, должен быть преподаватель.
export function groupReadiness(data, groupId) {
  const s = settingsOf(data);
  const used = usedCounts(data);
  const group = data.groups.find(g => g.id === groupId);
  const subjectName = item => data.subjects.find(x => x.id === item.subject_id)?.name ?? '?';
  const missing = [];
  let left = 0;
  for (const item of data.curriculum.filter(c => c.group_id === groupId)) {
    let itemLeft = 0;
    for (const kind of KINDS) {
      const p = plannedPairs(item, kind, s.hours_per_pair);
      if (!p) continue;
      const sids = isSplitKind(item, kind, group?.subgroups.length) ? group.subgroups.map(x => x.id) : [0];
      for (const sid of sids) itemLeft += Math.max(0, p - (used.get(unitKey(item.id, kind, sid)) ?? 0));
    }
    left += itemLeft;
    if (itemLeft && !data.teachers.some(t => t.id === item.teacher_id)) {
      missing.push({ curriculum_id: item.id, subject: subjectName(item) });
    }
  }
  return { ready: !missing.length && left > 0, missing, pairsLeft: left };
}

// options: { dates, groupIds, pairsPerDay, maxSameSubject }
// Возвращает новые занятия (без id) и отчёт по каждой группе и дню. Данные не меняет.
export function autoSchedule(data, options) {
  const s = settingsOf(data);
  const P = s.pairs_per_day;
  const N = Math.min(s.max_pairs, Math.max(1, options.pairsPerDay ?? s.max_pairs));
  const maxSame = Math.max(1, options.maxSameSubject ?? 2);
  const used = usedCounts(data);
  const teachers = new Map(data.teachers.map(t => [t.id, t]));
  const subjects = new Map(data.subjects.map(x => [x.id, x]));
  const ownedRooms = new Set(data.teachers.filter(t => t.room_id).map(t => t.room_id));
  const created = [];
  const report = [];

  for (const date of options.dates) {
    const wd = weekdayOf(date);
    const day = data.days[date];
    if (wd === 7) { report.push({ date, note: 'воскресенье — пропущено' }); continue; }
    if (day?.status === 'approved') { report.push({ date, note: 'расписание утверждено — не трогаю' }); continue; }

    // Кто и что уже занято в этот день (другие группы и уже поставленные сейчас пары)
    const busyT = new Set(), busyR = new Set();
    const occupy = l => {
      if (l.teacher_id) busyT.add(`${l.pair}|${l.teacher_id}`);
      if (l.room_id) busyR.add(`${l.pair}|${l.room_id}`);
    };
    const dayLessons = data.lessons.filter(l => l.date === date && l.status === 'active');
    dayLessons.forEach(occupy);

    const teacherFree = (tid, pair, extraBusy) => {
      const t = teachers.get(tid);
      if (!t) return false;
      const a = t.availability.find(x => x.weekday === wd);
      if (!a || pair < a.pair_from || pair > a.pair_to) return false;
      if (t.absences.some(x => x.date_from <= date && x.date_to >= date)) return false;
      return !busyT.has(`${pair}|${tid}`) && !extraBusy.t.has(`${pair}|${tid}`);
    };
    // Аудитория: закреплённая за преподавателем, иначе свободная общая подходящего типа (лучше — с нужным числом мест).
    const pickRoom = (unit, pair, people, extraBusy) => {
      const t = teachers.get(unit.item.teacher_id);
      const free = r => !busyR.has(`${pair}|${r.id}`) && !extraBusy.r.has(`${pair}|${r.id}`);
      if (t.room_id) {
        const own = data.rooms.find(r => r.id === t.room_id);
        return own && free(own) ? own.id : undefined;
      }
      if (!data.rooms.length) return null;
      const type = subjects.get(unit.item.subject_id)?.room_type;
      const pool = data.rooms.filter(r => !ownedRooms.has(r.id) && free(r) && (!type || r.type === type));
      if (!pool.length) return undefined;
      const fits = pool.filter(r => !r.capacity || r.capacity >= people).sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));
      return (fits[0] ?? pool.sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0))[0]).id;
    };

    for (const gid of options.groupIds) {
      const g = data.groups.find(x => x.id === gid);
      if (!g) continue;
      if (dayLessons.some(l => l.group_id === gid)) { report.push({ date, group: g.name, placed: 0, note: 'на этот день уже есть пары — не трогаю' }); continue; }
      if (!groupReadiness(data, gid).ready) { report.push({ date, group: g.name, placed: 0, note: 'нет преподавателей у части предметов или часы закончились' }); continue; }

      const subs = g.subgroups.map(x => x.id);
      const streams = subs.length ? subs : [0];
      const size = sid => (sid ? Math.ceil((g.size ?? 0) / subs.length) : (g.size ?? 0));

      // Единицы плана с остатком: предмет × вид × подгруппа
      const units = [];
      for (const item of data.curriculum.filter(c => c.group_id === gid && teachers.has(c.teacher_id))) {
        for (const kind of KINDS) {
          const planned = plannedPairs(item, kind, s.hours_per_pair);
          if (!planned) continue;
          const sids = isSplitKind(item, kind, subs.length) ? subs : [0];
          for (const sid of sids) {
            const key = unitKey(item.id, kind, sid);
            units.push({ item, kind, sid, key, planned, left: planned - (used.get(key) ?? 0) });
          }
        }
      }
      const byPriority = list => list.filter(u => u.left > 0)
        .sort((a, b) => b.left / b.planned - a.left / a.planned || b.left - a.left || a.item.id - b.item.id);

      // Пробная расстановка блока пар подряд, начиная с пары start. Ничего не меняет снаружи.
      const tryBlock = start => {
        const leftOf = new Map(units.map(u => [u.key, u.left]));
        const extra = { t: new Set(), r: new Set() };
        const sameSubj = new Map(); // `${sid}|${subject}` → сколько пар за день
        const placed = [];
        const can = (u, pair, sid) => {
          if ((leftOf.get(u.key) ?? 0) <= 0) return null;
          // Общая пара считается для всех подгрупп сразу
          const same = Math.max(...(sid ? [sid] : streams).map(st => sameSubj.get(`${st}|${u.item.subject_id}`) ?? 0));
          if (same >= maxSame) return null;
          if (!teacherFree(u.item.teacher_id, pair, extra)) return null;
          const room = pickRoom(u, pair, size(sid), extra);
          return room === undefined ? null : { room };
        };
        const take = (u, pair, sid, room) => {
          leftOf.set(u.key, leftOf.get(u.key) - 1);
          for (const st of sid ? [sid] : streams) sameSubj.set(`${st}|${u.item.subject_id}`, (sameSubj.get(`${st}|${u.item.subject_id}`) ?? 0) + 1);
          extra.t.add(`${pair}|${u.item.teacher_id}`);
          if (room) extra.r.add(`${pair}|${room}`);
          placed.push({ u, pair, sid, room });
        };
        // Сначала предметы, которых сегодня у этой группы/подгруппы ещё не было, потом — по доле оставшихся часов.
        const todayCount = u => Math.max(...(u.sid ? [u.sid] : streams).map(st => sameSubj.get(`${st}|${u.item.subject_id}`) ?? 0));
        const prio = () => byPriority(units.map(u => ({ ...u, left: leftOf.get(u.key) })))
          .map((u, i) => ({ u, i, c: todayCount(u) })).sort((a, b) => a.c - b.c || a.i - b.i).map(x => x.u);

        let length = 0;
        for (let pair = start; pair <= P && length < N; pair++) {
          const ranked = prio();
          // 1) общая пара для всей группы
          const whole = ranked.filter(u => u.sid === 0).map(u => ({ u, ok: can(u, pair, 0) })).find(x => x.ok);
          if (whole) { take(whole.u, pair, 0, whole.ok.room); length++; continue; }
          // 2) все подгруппы одновременно, каждая со своим предметом/преподавателем
          if (!subs.length) break;
          const snapshot = placed.length;
          const ok = subs.every(sid => {
            const pick = ranked.filter(u => u.sid === sid).map(u => ({ u, ok: can(u, pair, sid) })).find(x => x.ok);
            if (pick) take(pick.u, pair, sid, pick.ok.room);
            return Boolean(pick);
          });
          if (!ok) {
            // откатываем частично поставленные пары этой пары
            for (const p of placed.splice(snapshot)) {
              leftOf.set(p.u.key, leftOf.get(p.u.key) + 1);
              extra.t.delete(`${p.pair}|${p.u.item.teacher_id}`);
              if (p.room) extra.r.delete(`${p.pair}|${p.room}`);
              sameSubj.set(`${p.sid}|${p.u.item.subject_id}`, sameSubj.get(`${p.sid}|${p.u.item.subject_id}`) - 1);
            }
            break;
          }
          length++;
        }
        // 3) Если блок короче нужного — подгруппы могут добрать пары по краям (как «1–3 / 4–6»).
        if (subs.length && length && length < N) {
          const end = start + length - 1;
          for (const sid of subs) {
            let count = length;
            for (const dir of [1, -1]) {
              for (let pair = dir > 0 ? end + 1 : start - 1; pair >= 1 && pair <= P && count < N; pair += dir) {
                const pick = prio().filter(u => u.sid === sid).map(u => ({ u, ok: can(u, pair, sid) })).find(x => x.ok);
                if (!pick) break;
                take(pick.u, pair, sid, pick.ok.room);
                count++;
              }
            }
          }
        }
        return { placed, score: placed.length, length };
      };

      let best = { placed: [], score: 0 };
      for (let start = 1; start <= P; start++) {
        const t = tryBlock(start);
        if (t.score > best.score) best = t;
        if (best.length === N && !subs.length) break;
      }

      for (const p of best.placed) {
        const lesson = {
          date, pair: p.pair, group_id: gid, subgroup_id: p.sid || null, curriculum_id: p.u.item.id,
          kind: p.u.kind, teacher_id: p.u.item.teacher_id, room_id: p.room ?? null, status: 'active',
        };
        created.push(lesson);
        occupy(lesson);
        used.set(p.u.key, (used.get(p.u.key) ?? 0) + 1);
        const u = units.find(x => x.key === p.u.key);
        u.left--;
      }
      // «Пар» в отчёте — сколько пар у студента: у группы или у каждой подгруппы отдельно.
      const perStream = streams.map(sid => new Set(best.placed.filter(p => !p.sid || !sid || p.sid === sid).map(p => p.pair)).size);
      report.push({
        date, group: g.name, placed: Math.max(0, ...perStream),
        note: !best.placed.length ? 'не нашлось свободных преподавателей или аудиторий'
          : subs.length ? g.subgroups.map((sg, i) => `${sg.name}: ${perStream[i]}`).join(', ') : '',
      });
    }
  }
  return { lessons: created, report };
}
