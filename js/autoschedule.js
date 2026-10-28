// Автосоставление расписания по группам и дням.
//
// Для группы на день выбирается набор из N занятий (по умолчанию 4) и раскладывается на пары с 1-й подряд.
// У подгрупп набор предметов в день одинаковый, а порядок свой: общие пары группы стоят в одно время,
// занятия по подгруппам переставляются так, чтобы преподаватель не вёл две подгруппы сразу
// (например, П1: англ, англ, ОВП, БЖД; П2: БЖД, ОВП, англ, англ).
// Соблюдаются доступность, отсутствия и дневной лимит пар преподавателя, закреплённые аудитории,
// типы и вместимость аудиторий. В первую очередь ставятся предметы с наибольшей долей оставшихся часов.
import { KINDS, computeProgress, isSplitKind, settingsOf, teacherFor, unitKey, weekdayOf } from './logic.js';

const plannedPairs = (item, kind, hpp) => Math.ceil((item['h_' + kind] ?? 0) / hpp);

// Сколько уже стоит/проведено по каждой единице плана — со всеми черновиками и внесёнными часами.
const usedCounts = data => new Map(Object.entries(computeProgress(data, null, { allDrafts: true })));

// Занятия, которые можно ставить группе: предмет × вид; для деления на подгруппы — по части на каждую подгруппу.
function candidatesFor(data, group, used, teacherIds) {
  const s = settingsOf(data);
  const subs = group.subgroups.map(x => x.id);
  const out = [];
  for (const item of data.curriculum.filter(c => c.group_id === group.id)) {
    for (const kind of KINDS) {
      const planned = plannedPairs(item, kind, s.hours_per_pair);
      if (!planned) continue;
      const split = isSplitKind(item, kind, subs.length);
      const parts = (split ? subs : [0]).map(sid => {
        const key = unitKey(item.id, kind, sid);
        return { sid, key, teacher: teacherFor(item, kind, sid), left: planned - (used.get(key) ?? 0) };
      });
      out.push({ item, kind, split, parts, planned, subject: item.subject_id, missingTeacher: parts.some(p => !teacherIds.has(p.teacher)) });
    }
  }
  return out;
}

// Готова ли группа: у каждого занятия с оставшимися часами должен быть преподаватель.
export function groupReadiness(data, groupId) {
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return { ready: false, missing: [], pairsLeft: 0 };
  const teacherIds = new Set(data.teachers.map(t => t.id));
  const cands = candidatesFor(data, group, usedCounts(data), teacherIds);
  const missing = new Map();
  let left = 0;
  for (const c of cands) {
    const l = c.parts.reduce((x, p) => x + Math.max(0, Math.ceil(p.left)), 0);
    left += l;
    if (l && c.missingTeacher && !missing.has(c.item.id)) {
      missing.set(c.item.id, { curriculum_id: c.item.id, subject: data.subjects.find(x => x.id === c.subject)?.name ?? '?' });
    }
  }
  return { ready: !missing.size && left > 0, missing: [...missing.values()], pairsLeft: left };
}

// options: { dates, groupIds, pairsPerDay, maxSameSubject }
// Возвращает новые занятия (без id) и отчёт; сами данные не меняет.
export function autoSchedule(data, options) {
  const s = settingsOf(data);
  const P = s.pairs_per_day;
  const N = Math.min(s.max_pairs, Math.max(1, options.pairsPerDay ?? s.max_pairs));
  const maxSame = Math.max(1, options.maxSameSubject ?? 2);
  const used = usedCounts(data);
  const teachers = new Map(data.teachers.map(t => [t.id, t]));
  const teacherIds = new Set(teachers.keys());
  const subjects = new Map(data.subjects.map(x => [x.id, x]));
  const ownedRooms = new Set(data.teachers.filter(t => t.room_id).map(t => t.room_id));
  const created = [];
  const report = [];

  for (const date of options.dates) {
    const wd = weekdayOf(date);
    if (wd === 7) { report.push({ date, note: 'воскресенье — пропущено' }); continue; }
    if (data.days[date]?.status === 'approved') { report.push({ date, note: 'расписание утверждено — не трогаю' }); continue; }

    const dayLessons = data.lessons.filter(l => l.date === date && l.status === 'active');

    // Одна попытка составить день для групп в заданном порядке. Ничего снаружи не меняет:
    // работает со своей копией счётчиков used и своей занятостью.
    const attempt = (order, usedIn) => {
    const used = new Map(usedIn);
    const created = [], report = [];
    // Занятость в этот день: преподаватели и аудитории по парам, сколько пар у преподавателя
    const busyT = new Set(), busyR = new Set(), tDay = new Map();
    const occupy = (pair, tid, rid, sign = 1) => {
      if (tid) {
        const k = `${pair}|${tid}`;
        if (sign > 0) { busyT.add(k); tDay.set(tid, (tDay.get(tid) ?? 0) + 1); } else { busyT.delete(k); tDay.set(tid, tDay.get(tid) - 1); }
      }
      if (rid) { if (sign > 0) busyR.add(`${pair}|${rid}`); else busyR.delete(`${pair}|${rid}`); }
    };
    const seen = new Set();
    for (const l of dayLessons) {
      // одна пара преподавателя считается один раз, даже если записей несколько
      const k = `${l.pair}|${l.teacher_id}`;
      occupy(l.pair, seen.has(k) ? null : l.teacher_id, l.room_id);
      seen.add(k);
    }

    const teacherOk = (tid, pair) => {
      const t = teachers.get(tid);
      if (!t || busyT.has(`${pair}|${tid}`)) return false;
      const a = t.availability.find(x => x.weekday === wd);
      if (!a || pair < a.pair_from || pair > a.pair_to) return false;
      if (t.absences.some(x => x.date_from <= date && x.date_to >= date)) return false;
      return (tDay.get(tid) ?? 0) < s.teacher_max_pairs;
    };
    // Аудитория: закреплённая за преподавателем; иначе свободная общая нужного типа (лучше — по размеру).
    const pickRoom = (cand, tid, pair, people) => {
      const t = teachers.get(tid);
      const free = r => !busyR.has(`${pair}|${r.id}`);
      if (t.room_id) {
        const own = data.rooms.find(r => r.id === t.room_id);
        return own && free(own) ? own.id : undefined;
      }
      if (!data.rooms.length) return null;
      const type = subjects.get(cand.subject)?.room_type;
      const pool = data.rooms.filter(r => !ownedRooms.has(r.id) && free(r) && (!type || r.type === type));
      if (!pool.length) return undefined;
      const fits = pool.filter(r => !r.capacity || r.capacity >= people).sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));
      return (fits[0] ?? [...pool].sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0))[0]).id;
    };

    for (const gid of order) {
      const g = data.groups.find(x => x.id === gid);
      if (!g) continue;
      if (dayLessons.some(l => l.group_id === gid)) { report.push({ date, group: g.name, placed: 0, note: 'на этот день уже есть пары — не трогаю' }); continue; }
      if (!groupReadiness(data, gid).ready) { report.push({ date, group: g.name, placed: 0, note: 'нет преподавателей у части предметов или часы закончились' }); continue; }

      const subs = g.subgroups.map(x => x.id);
      const streams = subs.length ? subs : [0];
      const people = sid => (sid ? Math.ceil((g.size ?? 0) / subs.length) : (g.size ?? 0));
      // Порядок: сначала предметы с большей долей оставшихся часов (с шагом 10%), среди равных —
      // те, чьи преподаватели сегодня свободнее: так группы не спорят за одних и тех же людей.
      const ratio = c => Math.floor(Math.min(...c.parts.map(p => p.left / c.planned)) * 10);
      const freeToday = c => Math.min(...c.parts.map(p => s.teacher_max_pairs - (tDay.get(p.teacher) ?? 0)));
      // Сколько пар преподаватель ещё может взять сегодня (свободные часы доступности и дневной лимит).
      const slotsLeft = tid => {
        let free = 0;
        for (let pair = 1; pair <= P; pair++) if (teacherOk(tid, pair)) free++;
        return Math.min(free, s.teacher_max_pairs - (tDay.get(tid) ?? 0));
      };
      // Занятие годится, только если у его преподавателей хватит свободных пар (на каждую подгруппу — своя пара).
      const fitsToday = c => {
        const need = new Map();
        for (const p of c.parts) need.set(p.teacher, (need.get(p.teacher) ?? 0) + 1);
        return [...need].every(([tid, n]) => slotsLeft(tid) >= n);
      };
      const cands = candidatesFor(data, g, used, teacherIds)
        .filter(c => !c.missingTeacher && c.parts.every(p => p.left > 0) && fitsToday(c))
        .sort((a, b) => ratio(b) - ratio(a) || freeToday(b) - freeToday(a)
          || Math.min(...b.parts.map(p => p.left)) - Math.min(...a.parts.map(p => p.left)) || a.item.id - b.item.id);

      // Раскладка набора M на пары start, start+1, … перебором с возвратом.
      // Возвращает список занятий или null. Занятость (busyT/busyR/tDay) после вызова не меняется.
      const arrange = (M, start) => {
        const n = M.length;
        const restWhole = M.filter(c => !c.split);
        const restSplit = new Map(streams.map(sid => [sid, M.filter(c => c.split)]));
        const placed = [];
        const prevSubject = new Map();
        let budget = 2000; // ограничение перебора на один набор

        const put = (cand, part, pair) => {
          const tid = part.teacher;
          if (!teacherOk(tid, pair)) return false;
          const room = pickRoom(cand, tid, pair, people(part.sid));
          if (room === undefined) return false;
          occupy(pair, tid, room);
          placed.push({ cand, part, pair, room });
          return true;
        };
        const undo = count => {
          for (const p of placed.splice(placed.length - count)) occupy(p.pair, p.part.teacher, p.room, -1);
        };
        // Сначала тот же предмет, что был на прошлой паре (англ, англ), потом по порядку приоритета.
        const ordered = (list, sid) => {
          const prev = prevSubject.get(sid);
          return [...new Set(list)].sort((a, b) => (b.subject === prev) - (a.subject === prev));
        };

        const fillSplit = (pair, idx, next) => {
          if (idx === streams.length) return next();
          const sid = streams[idx];
          for (const cand of ordered(restSplit.get(sid), sid)) {
            if (--budget < 0) return false;
            const part = cand.parts.find(p => p.sid === sid);
            if (!put(cand, part, pair)) continue;
            const list = restSplit.get(sid);
            list.splice(list.indexOf(cand), 1);
            const before = prevSubject.get(sid);
            prevSubject.set(sid, cand.subject);
            if (fillSplit(pair, idx + 1, next)) return true;
            prevSubject.set(sid, before);
            list.push(cand);
            undo(1);
          }
          return false;
        };

        const step = pos => {
          if (pos === n) return true;
          const pair = start + pos;
          if (pair > P || --budget < 0) return false;
          // общая пара для всей группы
          for (const cand of [...new Set(restWhole)]) {
            if (!put(cand, cand.parts[0], pair)) continue;
            restWhole.splice(restWhole.indexOf(cand), 1);
            const before = new Map(prevSubject);
            for (const sid of streams) prevSubject.set(sid, cand.subject);
            if (step(pos + 1)) return true;
            prevSubject.clear();
            before.forEach((v, k) => prevSubject.set(k, v));
            restWhole.push(cand);
            undo(1);
          }
          // у каждой подгруппы своё занятие на этой паре
          if (subs.length && restSplit.get(streams[0]).length) {
            if (fillSplit(pair, 0, () => step(pos + 1))) return true;
          }
          return false;
        };

        const ok = step(0);
        const result = ok ? placed.slice() : null;
        undo(placed.length);
        return result;
      };

      // Перебор наборов из n занятий: сначала без повторов предмета, потом с повторами (до maxSame).
      const findDay = (n, start) => {
        let tries = 0;
        for (let allowSame = 1; allowSame <= maxSame; allowSame++) {
          const counts = new Map(), takes = new Map();
          const M = [];
          const dfs = from => {
            if (tries > 600) return null;
            if (M.length === n) {
              if (allowSame > 1 && ![...counts.values()].some(v => v > 1)) return null; // такой набор уже проверен
              tries++;
              return arrange(M, start);
            }
            for (let i = from; i < cands.length; i++) {
              const c = cands[i];
              const t = takes.get(c) ?? 0;
              if (t + 1 > Math.min(...c.parts.map(p => Math.ceil(p.left)))) continue;
              if ((counts.get(c.subject) ?? 0) + 1 > allowSame) continue;
              M.push(c);
              takes.set(c, t + 1);
              counts.set(c.subject, (counts.get(c.subject) ?? 0) + 1);
              const r = dfs(i);
              M.pop();
              takes.set(c, t);
              counts.set(c.subject, counts.get(c.subject) - 1);
              if (r) return r;
            }
            return null;
          };
          const r = dfs(0);
          if (r) return r;
        }
        return null;
      };

      // День начинается с 1-й пары. Позже — только если с 1-й выходит меньше половины нужных пар
      // (на 1-ю пару не хватает свободных преподавателей) и позже получается больше.
      let best = null, bestStart = 1;
      for (let n = N; n >= 1 && !best; n--) best = findDay(n, 1);
      const atFirst = best ? new Set(best.map(p => p.pair)).size : 0;
      if (atFirst < Math.ceil(N / 2)) {
        for (let start = 2; start <= P - atFirst; start++) {
          for (let n = Math.min(N, P - start + 1); n > atFirst; n--) {
            const r = findDay(n, start);
            if (r) { best = r; bestStart = start; break; }
          }
          if (bestStart > 1) break;
        }
      }

      for (const p of best ?? []) {
        const lesson = {
          date, pair: p.pair, group_id: gid, subgroup_id: p.part.sid || null, curriculum_id: p.cand.item.id,
          kind: p.cand.kind, teacher_id: p.part.teacher, room_id: p.room ?? null, status: 'active',
        };
        created.push(lesson);
        occupy(p.pair, p.part.teacher, p.room);
        used.set(p.part.key, (used.get(p.part.key) ?? 0) + 1);
        p.part.left--;
      }
      const pairs = new Set((best ?? []).map(p => p.pair)).size;
      report.push({
        date, group: g.name, placed: pairs,
        note: !pairs ? 'не нашлось свободных преподавателей или аудиторий'
          : bestStart > 1 ? `начинается с ${bestStart}-й пары: на 1-ю никто не свободен`
            : pairs < N ? 'меньше пар: не хватает свободных преподавателей' : '',
        late: bestStart > 1, gid,
      });
    }
    return { created, report, used };
    };

    // Сначала группы, у которых меньше разных преподавателей, — им труднее подобрать пары.
    const variety = gid => new Set(data.curriculum.filter(c => c.group_id === gid).flatMap(c => KINDS.map(k => teacherFor(c, k, 0)))).size;
    let order = [...options.groupIds].sort((a, b) => variety(a) - variety(b));
    // Оценка дня: больше пар, меньше дней не с 1-й пары.
    const score = r => r.report.reduce((x, i) => x + (i.placed ?? 0) * 10 - (i.late ? 15 : 0), 0);
    let best = attempt(order, used);
    // Если кому-то не хватило пар или 1-й пары — пробуем ещё раз, поставив эти группы первыми.
    for (let round = 0; round < 3; round++) {
      const hurt = best.report.filter(i => i.gid && (i.late || i.placed < N)).map(i => i.gid);
      if (!hurt.length) break;
      order = [...hurt, ...order.filter(id => !hurt.includes(id))];
      const next = attempt(order, used);
      if (score(next) <= score(best)) break;
      best = next;
    }
    created.push(...best.created);
    report.push(...best.report.map(({ late, gid, ...rest }) => rest));
    for (const [k, v] of best.used) used.set(k, v);
  }
  return { lessons: created, report };
}
