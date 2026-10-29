// Автосоставление расписания.
//
// День составляется по парам сразу для всех групп: сначала 1-я пара всем, потом 2-я и т.д.
// На каждой паре преподаватели распределяются между группами: первыми выбирают группы, у которых
// меньше вариантов, а преподаватель, нужный многим, достаётся тому, у кого нет замены (с простым обменом).
// Так 1-я пара достаётся всем, кому это вообще возможно.
//
// У группы в день от min до max пар подряд (по умолчанию 4–6). Сколько именно — по темпу: оставшиеся пары
// группы / оставшиеся учебные дни семестра (если в настройках заданы даты окончания семестров), иначе min.
//
// Подгруппы: в один день у них одни и те же предметы и одни и те же пары, в разном порядке. Варианты на пару:
//  • общее занятие всей группы;
//  • одно и то же занятие у всех подгрупп одновременно — если у подгрупп разные преподаватели;
//  • блок с перестановкой на столько пар, сколько подгрупп: П1 англ, П2 БЖД → П1 БЖД, П2 англ.
//    Блок резервируется целиком, поэтому у подгрупп всегда остаются одинаковые предметы.
// В первую очередь — предметы с большей долей оставшихся часов и самые загруженные преподаватели.
import {
  KINDS, computeProgress, isSplitKind, semesterOf, settingsOf, studyDaysLeft, teacherFor, unitKey, weekdayOf,
} from './logic.js';

const plannedPairs = (item, kind, hpp) => Math.ceil((item['h_' + kind] ?? 0) / hpp);

// Учебные дни с from по to включительно (пн–пт или пн–сб).
function countStudyDays(from, to, studyDays) {
  let n = 0;
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (wd <= studyDays) n++;
  }
  return n;
}

// Сколько уже стоит/проведено по каждой единице плана — со всеми черновиками и внесёнными часами.
const usedCounts = data => new Map(Object.entries(computeProgress(data, null, { allDrafts: true })));

// Занятия группы: предмет × вид; при делении — по части на каждую подгруппу. semester — только этого семестра.
function candidatesFor(data, group, used, teacherIds, semester = null) {
  const s = settingsOf(data);
  const subs = group.subgroups.map(x => x.id);
  const out = [];
  for (const item of data.curriculum.filter(c => c.group_id === group.id)) {
    if (semester && item.semester && item.semester !== semester) continue;
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
  const missing = new Map();
  let left = 0;
  for (const c of candidatesFor(data, group, usedCounts(data), teacherIds)) {
    const l = c.parts.reduce((x, p) => x + Math.max(0, Math.ceil(p.left)), 0);
    left += l;
    if (l && c.missingTeacher && !missing.has(c.item.id)) {
      missing.set(c.item.id, { curriculum_id: c.item.id, subject: data.subjects.find(x => x.id === c.subject)?.name ?? '?' });
    }
  }
  return { ready: !missing.size && left > 0, missing: [...missing.values()], pairsLeft: left };
}

// Сколько пар у каждого преподавателя осталось по плану (по всем группам).
export function teacherPairsLeft(data, semester = null) {
  const used = usedCounts(data);
  const teacherIds = new Set(data.teachers.map(t => t.id));
  const out = new Map();
  for (const g of data.groups) {
    for (const c of candidatesFor(data, g, used, teacherIds, semester)) {
      for (const p of c.parts) if (p.left > 0 && p.teacher) out.set(p.teacher, (out.get(p.teacher) ?? 0) + p.left);
    }
  }
  return out;
}

// options: { dates, groupIds, minPairs, maxPairs, maxSameSubject }
// Возвращает новые занятия (без id) и отчёт; сами данные не меняет.
export function autoSchedule(data, options) {
  const s = settingsOf(data);
  const P = s.pairs_per_day;
  const MIN = Math.min(P, Math.max(1, options.minPairs ?? s.min_pairs));
  const MAX = Math.min(P, Math.max(MIN, options.maxPairs ?? s.max_pairs));
  const maxSame = Math.max(1, options.maxSameSubject ?? s.max_same_subject);
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
    const semester = semesterOf(data, date);
    const daysLeft = studyDaysLeft(data, date);
    // Годовые предметы (без семестра) в 1-м семестре учитываем в темпе только своей долей:
    // оставшиеся дни семестра / оставшиеся дни учебного года.
    const daysToYearEnd = semester === 1 && s.semester2_end ? countStudyDays(date, s.semester2_end, s.study_days) : null;
    const yearShare = item => (!item.semester && daysLeft && daysToYearEnd ? daysLeft / daysToYearEnd : 1);

    // Загруженность преподавателей: самым загруженным пары ставятся в первую очередь.
    const teacherLeft = new Map();
    for (const g of data.groups) {
      for (const c of candidatesFor(data, g, used, teacherIds, semester)) {
        for (const p of c.parts) if (p.left > 0 && p.teacher) teacherLeft.set(p.teacher, (teacherLeft.get(p.teacher) ?? 0) + p.left);
      }
    }
    const busiest = Math.max(1, ...teacherLeft.values());
    const urgency = tid => (teacherLeft.get(tid) ?? 0) / busiest;

    const todo = [];
    for (const gid of options.groupIds) {
      const g = data.groups.find(x => x.id === gid);
      if (!g) continue;
      if (dayLessons.some(l => l.group_id === gid)) report.push({ date, group: g.name, placed: 0, note: 'на этот день уже есть пары — не трогаю' });
      else if (!groupReadiness(data, gid).ready) report.push({ date, group: g.name, placed: 0, note: 'нет преподавателей у части предметов или часы закончились' });
      else todo.push(g);
    }
    if (!todo.length) continue;

    const attempt = (boost, usedIn) => {
      const used = new Map(usedIn);
      // ---- занятость дня
      const busyT = new Set(), busyR = new Set(), tDay = new Map();
      const occupy = (pair, tid, rid, sign = 1) => {
        if (tid) {
          if (sign > 0) { busyT.add(`${pair}|${tid}`); tDay.set(tid, (tDay.get(tid) ?? 0) + 1); } else { busyT.delete(`${pair}|${tid}`); tDay.set(tid, tDay.get(tid) - 1); }
        }
        if (rid) { if (sign > 0) busyR.add(`${pair}|${rid}`); else busyR.delete(`${pair}|${rid}`); }
      };
      const seen = new Set();
      for (const l of dayLessons) {
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

      // ---- состояние групп
      const G = todo.map(g => {
        const subs = g.subgroups.map(x => x.id);
        const streams = subs.length ? subs : [0];
        const cands = candidatesFor(data, g, used, teacherIds, semester).filter(c => !c.missingTeacher && c.parts.every(p => p.left > 0));
        const leftPairs = Math.max(...streams.map(sid => cands.reduce((x, c) => x + Math.max(0, ((c.parts.find(p => p.sid === sid || p.sid === 0)?.left) ?? 0) * yearShare(c.item)), 0)));
        const allLeft = Math.max(...streams.map(sid => cands.reduce((x, c) => x + Math.max(0, Math.ceil((c.parts.find(p => p.sid === sid || p.sid === 0)?.left) ?? 0)), 0)));
        let target = daysLeft ? Math.ceil(leftPairs / daysLeft) : MIN;
        target = Math.min(MAX, Math.max(MIN, target), allLeft);
        return {
          g, subs, streams, cands, target, k: 0, start: 0, closed: !target, placed: [],
          subj: new Map(streams.map(sid => [sid, new Map()])), // поток → предмет → сколько раз сегодня
          people: sid => (sid ? Math.ceil((g.size ?? 0) / subs.length) : (g.size ?? 0)),
          boost: boost.get(g.id) ?? 0,
        };
      });

      const part = (c, sid) => c.parts.find(p => p.sid === sid);
      // Важность занятия: доля оставшихся часов предмета и загруженность его преподавателя (поровну).
      const weight = (c, sid) => { const p = c.split ? part(c, sid) : c.parts[0]; return (p.left / c.planned + urgency(p.teacher)) / 2; };

      // Варианты для группы, начиная с пары pair. Вариант — список занятий { cand, part, pair } на 1 или несколько пар.
      const optionsFor = (st, pair) => {
        const out = [];
        const room = MAX - st.k; // сколько пар ещё можно поставить
        const subjOk = (sid, c, times = 1) => (st.subj.get(sid).get(c.subject) ?? 0) + times <= maxSame;
        const leftOk = c => c.parts.every(p => p.left > 0);
        // 1) общее занятие всей группы
        for (const c of st.cands) {
          if (c.split || !leftOk(c) || !st.streams.every(sid => subjOk(sid, c))) continue;
          if (!teacherOk(c.parts[0].teacher, pair)) continue;
          out.push({ span: 1, lessons: [{ cand: c, part: c.parts[0], pair }], prio: weight(c, 0) });
        }
        if (!st.subs.length) return out;
        const splits = st.cands.filter(c => c.split && leftOk(c));
        // 2) одно занятие у всех подгрупп сразу — когда у подгрупп разные преподаватели
        for (const c of splits) {
          const ts = st.streams.map(sid => part(c, sid).teacher);
          if (new Set(ts).size !== ts.length || !st.streams.every(sid => subjOk(sid, c))) continue;
          if (!ts.every(t => teacherOk(t, pair))) continue;
          out.push({ span: 1, lessons: st.streams.map(sid => ({ cand: c, part: part(c, sid), pair })), prio: Math.min(...st.streams.map(sid => weight(c, sid))) });
        }
        // 3) блок с перестановкой: m разных занятий на m пар, подгруппа j на паре i берёт занятие (j + i) mod m
        const m = st.streams.length;
        if (m > room || pair + m - 1 > P) return out;
        const pool = splits.filter(c => st.streams.every(sid => subjOk(sid, c)));
        const pick = [];
        let tries = 0;
        const dfs = () => {
          if (tries > 400) return;
          if (pick.length === m) {
            tries++;
            const lessons = [];
            for (let i = 0; i < m; i++) {
              const ts = new Set();
              for (let j = 0; j < m; j++) {
                const c = pick[(j + i) % m], p = part(c, st.streams[j]);
                if (ts.has(p.teacher) || !teacherOk(p.teacher, pair + i)) return;
                ts.add(p.teacher);
                lessons.push({ cand: c, part: p, pair: pair + i });
              }
            }
            // один и тот же преподаватель в блоке не должен превысить дневной лимит
            const perT = new Map();
            for (const l of lessons) perT.set(l.part.teacher, (perT.get(l.part.teacher) ?? 0) + 1);
            if ([...perT].some(([t, n]) => (tDay.get(t) ?? 0) + n > s.teacher_max_pairs)) return;
            out.push({ span: m, lessons, prio: Math.min(...pick.flatMap(c => st.streams.map(sid => weight(c, sid)))) });
            return;
          }
          for (const c of pool) {
            if (pick.includes(c)) continue;
            pick.push(c);
            dfs();
            pick.pop();
          }
        };
        dfs();
        return out;
      };

      // Резерв преподавателей и аудиторий под вариант; false — если что-то занято или нет аудитории.
      const reserve = (st, opt) => {
        const done = [];
        const undo = () => { for (const d of done) occupy(d.pair, d.part.teacher, d.room, -1); };
        for (const l of opt.lessons) {
          if (!teacherOk(l.part.teacher, l.pair)) { undo(); return false; }
          const room = pickRoom(l.cand, l.part.teacher, l.pair, st.people(l.part.sid));
          if (room === undefined) { undo(); return false; }
          occupy(l.pair, l.part.teacher, room);
          done.push({ ...l, room });
        }
        opt.placed = done;
        return true;
      };
      const release = opt => { for (const d of opt.placed ?? []) occupy(d.pair, d.part.teacher, d.room, -1); opt.placed = null; };

      const apply = (st, opt, pair) => {
        st.k += opt.span;
        if (!st.start) st.start = pair;
        for (const l of opt.placed) {
          l.part.left -= 1;
          used.set(l.part.key, (used.get(l.part.key) ?? 0) + 1);
          for (const sid of l.cand.split ? [l.part.sid] : st.streams) {
            st.subj.get(sid).set(l.cand.subject, (st.subj.get(sid).get(l.cand.subject) ?? 0) + 1);
          }
        }
        st.placed.push(opt);
      };

      // ---- по парам
      for (let pair = 1; pair <= P; pair++) {
        // группы, у которых день ещё идёт (или ещё не начался) и следующая пара — эта
        const open = G.filter(st => !st.closed && st.k < st.target && (st.k === 0 || st.start + st.k === pair));
        const opts = new Map(open.map(st => [st, optionsFor(st, pair)]));
        // насколько каждый преподаватель нужен на этой паре разным группам
        const demand = new Map();
        for (const list of opts.values()) {
          for (const t of new Set(list.flatMap(o => o.lessons.filter(l => l.pair === pair).map(l => l.part.teacher)))) demand.set(t, (demand.get(t) ?? 0) + 1);
        }
        // Важность (шаг 1%), затем — преподаватели, которые меньше нужны другим группам на этой паре.
        // Блок не должен сильно перескочить нужное число пар.
        const score = (st, o) => Math.floor(o.prio * 100) * 100
          - (st.k + o.span > st.target ? 50 : 0)
          - o.lessons.filter(l => l.pair === pair).reduce((x, l) => x + (demand.get(l.part.teacher) ?? 0), 0) / o.lessons.length;
        for (const [st, list] of opts) list.sort((a, b) => score(st, b) - score(st, a));
        // первыми — уже начавшие день (иначе у них будет обрыв), затем те, кому не хватило в прошлой попытке,
        // затем у кого меньше вариантов
        const order = [...opts.keys()].sort((a, b) => (b.k > 0) - (a.k > 0) || b.boost - a.boost || opts.get(a).length - opts.get(b).length);
        const chosen = new Map();
        for (const st of order) {
          const list = opts.get(st);
          let got = list.find(o => reserve(st, o));
          if (!got) {
            // обмен: освобождаем преподавателя у другой группы, если у неё есть запасной вариант
            for (const o of list.slice(0, 8)) {
              const need = new Set(o.lessons.map(l => `${l.pair}|${l.part.teacher}`));
              const holder = [...chosen].find(([, ho]) => ho.lessons.some(l => need.has(`${l.pair}|${l.part.teacher}`)));
              if (!holder) continue;
              const [hst, hopt] = holder;
              release(hopt);
              if (reserve(st, o)) {
                const alt = opts.get(hst).find(x => x !== hopt && reserve(hst, x));
                if (alt) { chosen.set(hst, alt); got = o; break; }
                release(o);
              }
              reserve(hst, hopt);
            }
          }
          if (got) chosen.set(st, got);
        }
        for (const st of open) {
          const o = chosen.get(st);
          if (o) apply(st, o, pair);
          else if (st.k > 0) st.closed = true; // дальше пар нет — день группы закончился
        }
        for (const st of G) if (st.k >= st.target) st.closed = true;
      }

      const out = [], rep = [];
      let total = 0;
      for (const st of G) {
        for (const opt of st.placed) {
          for (const l of opt.placed) {
            out.push({
              date, pair: l.pair, group_id: st.g.id, subgroup_id: l.part.sid || null, curriculum_id: l.cand.item.id,
              kind: l.cand.kind, teacher_id: l.part.teacher, room_id: l.room ?? null, status: 'active',
            });
          }
        }
        const late = st.k && st.start > 1;
        const short = st.k < Math.min(st.target, MIN);
        total += st.k * 10 - (st.k < st.target ? (st.target - st.k) * 15 : 0) - (late ? 20 : 0);
        rep.push({
          date, group: st.g.name, placed: st.k, gid: st.g.id, problem: late || st.k < st.target,
          note: !st.k ? 'не нашлось свободных преподавателей'
            : [late ? `начинается с ${st.start}-й пары: на 1-ю никто не свободен` : '',
              short ? `меньше ${MIN}: не хватает свободных преподавателей` : st.k < st.target ? `меньше нужных ${st.target}` : '',
              st.target > MIN ? `по темпу нужно ${st.target} пар в день` : ''].filter(Boolean).join('; '),
        });
      }
      return { created: out, report: rep, used, score: total };
    };

    // Несколько попыток: группы, которым не хватило пар или 1-й пары, получают приоритет.
    const boost = new Map();
    let best = attempt(boost, used);
    for (let round = 0; round < 6; round++) {
      const hurt = best.report.filter(r => r.problem);
      if (!hurt.length) break;
      for (const r of hurt) boost.set(r.gid, (boost.get(r.gid) ?? 0) + 10);
      const next = attempt(boost, used);
      if (next.score > best.score) best = next;
    }
    created.push(...best.created);
    report.push(...best.report.map(({ gid, problem, ...rest }) => rest));
    for (const [k, v] of best.used) used.set(k, v);
  }
  return { lessons: created, report };
}
