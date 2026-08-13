import { initTheme, registerSW, el, store, encodeState, decodeState, copyText } from '../../assets/shell.js';

initTheme();
registerSW('../../sw.js');

/* ============================================================
   State
   ============================================================ */

const KEY = 'meetingFit.v3';

let MODEL = null;
let TYPES = [];
const TIDX = {};

const state = {
  teams: [],           // { id, name }
  people: [],          // { id, name, levels, team }
  teamFilter: 'all',   // which team the Team tab is showing
  criteria: ['decide'], // what the leader counts as a good meeting
  meetings: [],        // { id, title, outcome, required[], attendees[], date, minutes, touched, debriefs{} }
  currentId: null,
  viewerId: null,
  leaderId: null,
  me: { name: '', levels: 'cccccc' },
};

const save = () => store.set(KEY, JSON.stringify({
  people: state.people, teams: state.teams, meetings: state.meetings, currentId: state.currentId,
  criteria: state.criteria, teamFilter: state.teamFilter,
  viewerId: state.viewerId, leaderId: state.leaderId, me: state.me,
}));

function load() {
  const raw = store.get(KEY);
  if (!raw) return false;
  try { Object.assign(state, JSON.parse(raw)); return true; } catch { return false; }
}

const uid = (p = 'p') => p + Math.random().toString(36).slice(2, 9);
const byId = (id) => state.people.find((p) => p.id === id);
const teamById = (id) => state.teams.find((t) => t.id === id);
const teamName = (p) => teamById(p.team)?.name || '—';
const peopleOf = (teamId) => (teamId === 'all' ? state.people : state.people.filter((p) => p.team === teamId));
const current = () => state.meetings.find((m) => m.id === state.currentId) || null;
const viewer = () => byId(state.viewerId) || state.people[0] || null;
const isLeader = () => state.viewerId && state.viewerId === state.leaderId;

const levelsOf = (p, tid) => p.levels[TIDX[tid]];
const geniusesOf = (p) => TYPES.filter((t) => levelsOf(p, t.id) === 'g');
const typeById = (id) => TYPES.find((t) => t.id === id);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/* ============================================================
   Profile codes
   ============================================================ */

const encodeProfile = (p) => encodeState([p.name, p.levels]);

function decodeProfile(code) {
  const raw = decodeState(code.trim());
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [name, levels] = raw;
  if (typeof name !== 'string' || !validLevels(levels)) return null;
  return { id: uid(), name: name.slice(0, 40) || 'Unnamed', levels };
}

function validLevels(lv) {
  if (typeof lv !== 'string' || lv.length !== TYPES.length || !/^[gcf]+$/.test(lv)) return false;
  return ['g', 'c', 'f'].every((k) => [...lv].filter((c) => c === k).length === MODEL.perPerson[k]);
}

/* ============================================================
   Dates
   ============================================================ */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekDates(ref = new Date()) {
  const d = new Date(ref);
  const dow = (d.getDay() + 6) % 7;          // Monday = 0
  d.setDate(d.getDate() - dow);
  return DAY_NAMES.map((_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return isoDate(x);
  });
}

const fmtMins = (m) => (m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)}h` : `${Math.round(m)}m`);
const pct = (x) => `${Math.round(x * 100)}%`;

/* ============================================================
   Outcome text -> suggested types
   ============================================================ */

const CUES = {
  wonder: ['explore', 'why', 'should we', 'opportunity', 'understand', 'landscape', 'question', 'what if', 'reframe', 'is there'],
  invention: ['brainstorm', 'idea', 'design', 'come up with', 'generate', 'concept', 'options', 'propose', 'draft', 'invent', 'solution', 'approach'],
  discernment: ['decide', 'decision', 'choose', 'select', 'evaluate', 'prioriti', 'go/no-go', 'assess', 'review', 'vet', 'narrow', 'which', 'pick', 'down-select', 'downselect', 'judge', 'recommend'],
  galvanizing: ['align', 'buy-in', 'buy in', 'kickoff', 'kick off', 'rally', 'commit', 'socialize', 'sell', 'launch', 'momentum', 'sponsor', 'convince', 'persuade', 'sign off', 'sign-off', 'approval', 'escalat'],
  enablement: ['support', 'help', 'unblock', 'resourc', 'onboard', 'assist', 'coordinat', 'enable', 'staff', 'hand off', 'handoff', 'train', 'respond'],
  tenacity: ['finish', 'close out', 'closeout', 'ship', 'deliver', 'deadline', 'complete', 'status', 'track', 'milestone', 'wrap', 'follow through', 'due', 'execute'],
};

function suggestTypes(text) {
  const s = (text || '').toLowerCase();
  if (!s.trim()) return [];
  return TYPES
    .map((t) => ({ id: t.id, n: (CUES[t.id] || []).filter((c) => s.includes(c)).length }))
    .filter((h) => h.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((h) => h.id);
}

/* ============================================================
   Load maths
   ============================================================ */

// How a meeting's minutes land on one person. A debrief, when present,
// overrides the prediction — what happened beats what the profile expected.
function meetingSplit(person, m) {
  const mins = m.minutes || 60;
  const felt = m.debriefs?.[person.id]?.felt;
  if (felt === 'draining') return { g: 0, c: 0, f: mins, reported: true };
  if (felt === 'energizing') return { g: mins, c: 0, f: 0, reported: true };
  if (felt === 'fine') return { g: 0, c: mins, f: 0, reported: true };

  const req = (m.required || []).filter((id) => TIDX[id] !== undefined);
  if (!req.length) return { g: 0, c: mins, f: 0, reported: false };
  const share = mins / req.length;
  const out = { g: 0, c: 0, f: 0, reported: false };
  for (const tid of req) out[levelsOf(person, tid)] += share;
  return out;
}

function dayLoad(person, date) {
  const ms = state.meetings.filter((m) => m.date === date && m.attendees.includes(person.id));
  const tot = { g: 0, c: 0, f: 0, minutes: 0, meetings: ms };
  for (const m of ms) {
    const s = meetingSplit(person, m);
    tot.g += s.g; tot.c += s.c; tot.f += s.f; tot.minutes += (m.minutes || 60);
  }
  return tot;
}

function weekLoad(person, dates) {
  const tot = { g: 0, c: 0, f: 0, minutes: 0 };
  for (const d of dates) {
    const l = dayLoad(person, d);
    tot.g += l.g; tot.c += l.c; tot.f += l.f; tot.minutes += l.minutes;
  }
  return tot;
}

function faceFor(loadObj, days = 1) {
  const wd = MODEL.load.workdayMinutes * days;
  const th = MODEL.load.thresholds;
  const fp = loadObj.f / wd;
  const gp = loadObj.g / wd;
  let id;
  if (loadObj.minutes === 0) id = 'fine';
  else if (fp >= th.frustrationStrained) id = 'strained';
  else if (fp >= th.frustrationHeavy) id = 'heavy';
  else if (gp >= th.geniusThriving) id = 'thriving';
  else id = 'fine';
  return { ...MODEL.load.faces.find((f) => f.id === id), fp, gp };
}

function faceSVG(status, id, big = false) {
  const mouth = {
    thriving: 'M 26 58 Q 50 80 74 58',
    fine: 'M 30 62 Q 50 72 70 62',
    heavy: 'M 30 66 L 70 66',
    strained: 'M 28 72 Q 50 50 72 72',
  }[id] || 'M 30 62 Q 50 72 70 62';
  const brows = id === 'strained'
    ? '<path class="stroke" d="M 24 30 L 40 38"/><path class="stroke" d="M 76 30 L 60 38"/>'
    : '';
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('class', `face ${status}${big ? ' lg' : ''}`);
  s.setAttribute('role', 'img');
  s.innerHTML = `<circle class="ring" cx="50" cy="50" r="44"/>
    ${brows}
    <circle class="eye" cx="35" cy="44" r="5"/>
    <circle class="eye" cx="65" cy="44" r="5"/>
    <path class="stroke" d="${mouth}"/>`;
  return s;
}

function mixBar(l) {
  const total = l.g + l.c + l.f;
  const bar = el('div', { class: 'mix' });
  if (total <= 0) {
    bar.append(el('div', { class: 'seg c only', style: 'flex:1;opacity:.35' }));
    return bar;
  }
  const parts = [['g', l.g], ['c', l.c], ['f', l.f]].filter(([, v]) => v > 0);
  parts.forEach(([k, v], i) => {
    bar.append(el('div', {
      class: `seg ${k}${parts.length === 1 ? ' only' : ''}`,
      style: `flex-basis:${(v / total) * 100}%`,
      title: `${MODEL.levels.find((x) => x.id === k).name}: ${fmtMins(v)} (${pct(v / total)} of tracked time)`,
    }));
    void i;
  });
  return bar;
}

/* ============================================================
   Meeting analysis
   ============================================================ */

const STATUS_LABEL = { good: 'Covered', warning: 'Thin', serious: 'Competency only', critical: 'Gap' };

function analyze(m) {
  const inRoom = state.people.filter((p) => m.attendees.includes(p.id));
  const bench = state.people.filter((p) => !m.attendees.includes(p.id));
  const required = (m.required || []).map(typeById).filter(Boolean);

  const coverage = required.map((type) => {
    const g = inRoom.filter((p) => levelsOf(p, type.id) === 'g');
    const c = inRoom.filter((p) => levelsOf(p, type.id) === 'c');
    const f = inRoom.filter((p) => levelsOf(p, type.id) === 'f');
    const rescue = bench.filter((p) => levelsOf(p, type.id) === 'g');
    let status;
    if (!g.length && !c.length) status = 'critical';
    else if (!g.length) status = 'serious';
    else if (g.length === 1) status = 'warning';
    else status = 'good';
    return { type, g, c, f, rescue, status };
  });

  return {
    inRoom, bench, required, coverage,
    gaps: coverage.filter((c) => c.status === 'critical' || c.status === 'serious'),
    thin: coverage.filter((c) => c.status === 'warning'),
    idle: inRoom.filter((p) => !required.some((t) => levelsOf(p, t.id) === 'g')),
    drained: inRoom.filter((p) => required.filter((t) => levelsOf(p, t.id) === 'f').length >= 2),
    composition: composition(inRoom, required),
  };
}

// Responsive/Disruptive balance and altitude fit — the two lenses the
// framework applies to a room, over and above type coverage.
function composition(inRoom, required) {
  let responsive = 0, disruptive = 0;
  for (const p of inRoom) {
    for (const t of geniusesOf(p)) {
      if (t.mode === 'responsive') responsive += 1; else disruptive += 1;
    }
  }
  const total = responsive + disruptive;
  let modeVerdict = null;
  if (total >= 4) {
    const dShare = disruptive / total;
    if (dShare >= 0.75) {
      modeVerdict = { status: 'warning', text: 'Almost everyone here provokes rather than responds. Plenty will get pushed; very little will get weighed, and the quieter people will be talked past.' };
    } else if (dShare <= 0.25) {
      modeVerdict = { status: 'warning', text: 'Almost everyone here responds rather than provokes. Nobody in this room naturally puts something on the table, so the meeting will wait for a proposal that never arrives.' };
    } else {
      modeVerdict = { status: 'good', text: 'The room has both — people who put things on the table and people who weigh them.' };
    }
  }

  const mAlt = required.length ? mean(required.map((t) => t.altitude)) : null;
  const people = inRoom.map((p) => ({ p, alt: mean(geniusesOf(p).map((t) => t.altitude)) }));
  const off = mAlt === null ? [] : people.filter((x) => Math.abs(x.alt - mAlt) >= 2);
  const high = off.filter((x) => x.alt < mAlt);
  const low = off.filter((x) => x.alt > mAlt);

  return { responsive, disruptive, total, modeVerdict, mAlt, people, off, high, low };
}

/* --- the organizer's choice: which variable is allowed to move --- */

// Fix the outcome → the room moves. Smallest set of people off the bench
// that closes every gap.
function minimumRoster(a) {
  const remaining = new Set(a.gaps.map((c) => c.type.id));
  const pool = [...a.bench];
  const picks = [];

  while (remaining.size && pool.length) {
    let best = null;
    let bestCover = [];
    for (const p of pool) {
      const cover = [...remaining].filter((tid) => levelsOf(p, tid) === 'g');
      if (cover.length > bestCover.length) { best = p; bestCover = cover; }
    }
    if (!best || !bestCover.length) break;
    picks.push({ person: best, covers: bestCover.map(typeById) });
    bestCover.forEach((tid) => remaining.delete(tid));
    pool.splice(pool.indexOf(best), 1);
  }
  return { picks, stillMissing: [...remaining].map(typeById) };
}

// Fix the people → the meeting moves. What this room can actually carry,
// what has to come off the agenda, and what shape it is really suited to.
function reshape(a) {
  const canDo = a.coverage.filter((c) => c.status === 'good' || c.status === 'warning').map((c) => c.type);
  const cannot = a.gaps.map((c) => c.type);
  const roomGenius = new Set(a.inRoom.flatMap((p) => geniusesOf(p).map((t) => t.id)));
  const scored = MODEL.archetypes
    .map((ar) => ({ ar, score: ar.types.filter((t) => roomGenius.has(t)).length / ar.types.length }))
    .sort((x, y) => y.score - x.score);
  return { canDo, cannot, best: scored[0], roomGenius };
}

function verdictSentence(a) {
  if (!a.required.length) return 'Pick what the meeting needs and the read will appear here.';
  if (!a.inRoom.length) return 'Nobody is in the room yet. Add attendees to see whether the meeting matches them.';
  const multi = new Set(a.inRoom.map((p) => p.team)).size > 1;
  const names = (arr) => arr.map((p) => (multi ? `${p.name} (${teamName(p)})` : p.name)).join(', ');

  if (a.gaps.length) {
    const list = a.gaps.map((c) => c.type.name);
    const label = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.slice(-1)}`;
    const worst = a.gaps.find((c) => c.status === 'critical') || a.gaps[0];
    let s = `This meeting needs ${label}, and the room is not built for it. `;
    if (worst.status === 'critical') {
      s += `Nobody here is energized by ${worst.type.name}`;
      if (worst.f.length) s += `, and ${worst.f.length === 1 ? `${names(worst.f)} is` : `${names(worst.f)} are`} drained by it`;
      s += '. ';
    } else {
      s += `${worst.type.name} is carried only as a competency — it will get done in the room and cost someone afterwards. `;
    }
    const ho = MODEL.handoffs.find((h) => h.to === worst.type.phase);
    const phase = MODEL.phases.find((p) => p.id === worst.type.phase);
    return s + (ho
      ? `Expect the classic ${phase.name.toLowerCase()} failure: ${ho.symptom.toLowerCase()}`
      : `Expect the ${phase.name.toLowerCase()} half of this meeting to stall.`);
  }

  if (a.thin.length) {
    const t = a.thin[0];
    return `The room covers what the meeting needs, but ${t.type.name} rests on one person — ${names(t.g)}. If they are quiet, that part of the meeting does not happen.`;
  }
  return 'The room matches the meeting. Every type this meeting needs has more than one person here who gains energy from it.';
}


/* ============================================================
   Leader criteria — what counts as a good meeting here
   ============================================================ */

const activeCriteria = () =>
  (MODEL.criteria || []).filter((c) => (state.criteria || []).includes(c.id));

// A type's importance is the strongest claim any active criterion makes on it.
function weightFor(typeId) {
  const active = activeCriteria();
  if (!active.length) return 1;
  return Math.max(1, ...active.map((c) => c.weights?.[typeId] || 0));
}

const GAP_COST = { critical: 1, serious: 0.7, warning: 0.35, good: 0 };

// Weighted exposure, 0..1 — how much of what this leader cares about is at risk.
function criteriaRisk(a) {
  if (!a.coverage.length) return { score: 0, ranked: [], worst: null };
  const ranked = a.coverage
    .map((c) => ({ ...c, weight: weightFor(c.type.id), cost: weightFor(c.type.id) * GAP_COST[c.status] }))
    .sort((x, y) => y.cost - x.cost);
  const max = ranked.reduce((s, c) => s + c.weight, 0) || 1;
  const score = ranked.reduce((s, c) => s + c.cost, 0) / max;
  return { score: Math.min(1, score), ranked, worst: ranked[0]?.cost > 0 ? ranked[0] : null };
}

const loadAware = () => activeCriteria().some((c) => c.loadAware);

// For 'nobody burned': who walks in already past the line today
function strainedAttendees(m, a) {
  if (!m.date) return [];
  return a.inRoom.filter((p) => faceFor(dayLoad(p, m.date), 1).id === 'strained');
}

/* ============================================================
   Forecast — logistic regression over this device's own debriefs
   ============================================================ */

const FEATURES = [
  { k: 'gaps',        label: 'uncovered types',        f: (x) => Math.min(3, x.gaps) / 3 },
  { k: 'critical',    label: 'a type nobody can do',   f: (x) => (x.critical ? 1 : 0) },
  { k: 'thin',        label: 'a type resting on one person', f: (x) => Math.min(2, x.thin) / 2 },
  { k: 'size',        label: 'headcount',              f: (x) => Math.min(12, x.size) / 12 },
  { k: 'minutes',     label: 'length',                 f: (x) => Math.min(180, x.minutes) / 180 },
  { k: 'skew',        label: 'responsive/disruptive skew', f: (x) => Math.abs(x.dShare - 0.5) * 2 },
  { k: 'altitude',    label: 'altitude mismatch',      f: (x) => Math.min(1, x.offAlt / Math.max(1, x.size)) },
  { k: 'drain',       label: 'draining for the room',  f: (x) => x.drainShare },
];

function featuresOf(m) {
  const a = analyze(m);
  const comp = a.composition;
  const inRoom = a.inRoom;
  const drain = inRoom.length
    ? inRoom.reduce((s, p) => { const sp = meetingSplit(p, m); const t = sp.g + sp.c + sp.f; return s + (t ? sp.f / t : 0); }, 0) / inRoom.length
    : 0;
  return {
    gaps: a.gaps.length,
    critical: a.coverage.some((c) => c.status === 'critical'),
    thin: a.thin.length,
    size: inRoom.length,
    minutes: m.minutes || 60,
    dShare: comp.total ? comp.disruptive / comp.total : 0.5,
    offAlt: comp.off.length,
    drainShare: drain,
  };
}

const OUTCOME_SCORE = { yes: 1, partly: 0.5, no: 0 };

function trainingRows() {
  const rows = [];
  for (const m of state.meetings) {
    const votes = Object.values(m.debriefs || {}).map((d) => d.outcome).filter((o) => o in OUTCOME_SCORE);
    if (!votes.length || !m.attendees.length || !(m.required || []).length) continue;
    const y = votes.reduce((s, v) => s + OUTCOME_SCORE[v], 0) / votes.length;
    rows.push({ x: FEATURES.map((ft) => ft.f(featuresOf(m))), y, m });
  }
  return rows;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Plain gradient descent with L2. Tiny data, tiny model, runs in a millisecond.
function trainForecast(rows, { epochs = 400, lr = 0.35, l2 = 0.05 } = {}) {
  const n = FEATURES.length;
  const w = new Array(n).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(n).fill(0);
    let gb = 0;
    for (const r of rows) {
      const p = sigmoid(r.x.reduce((s, v, i) => s + v * w[i], b));
      const err = p - r.y;
      for (let i = 0; i < n; i += 1) gw[i] += err * r.x[i];
      gb += err;
    }
    for (let i = 0; i < n; i += 1) w[i] -= lr * (gw[i] / rows.length + l2 * w[i]);
    b -= lr * (gb / rows.length);
  }
  return { w, b };
}

function forecast(m) {
  const cfg = MODEL.forecast || {};
  const rows = trainingRows();
  const n = rows.length;
  const base = rows.length ? rows.reduce((s, r) => s + r.y, 0) / rows.length : null;

  // the rules-based prior: what the current read implies on its own
  const a = analyze(m);
  const risk = criteriaRisk(a).score;
  const prior = Math.max(0.05, Math.min(0.95, 0.85 - 0.7 * risk));

  if (n < (cfg.minMeetings || 4)) {
    return { ready: false, n, prior, needed: (cfg.minMeetings || 4) - n };
  }

  const model = trainForecast(rows);
  const x = FEATURES.map((ft) => ft.f(featuresOf(m)));
  const raw = sigmoid(x.reduce((s, v, i) => s + v * model.w[i], model.b));

  // shrink toward the prior until there is enough evidence to earn the claim
  const k = cfg.shrinkK || 15;
  const trust = n / (n + k);
  const p = trust * raw + (1 - trust) * prior;

  const contrib = FEATURES
    .map((ft, i) => ({ label: ft.label, v: model.w[i] * x[i] }))
    .filter((c) => Math.abs(c.v) > 0.05)
    .sort((c1, c2) => c1.v - c2.v);

  return {
    ready: true, n, p, raw, prior, trust,
    confident: n >= (cfg.confidentAt || 20),
    base,
    hurts: contrib.filter((c) => c.v < 0).slice(0, 2),
    helps: contrib.filter((c) => c.v > 0).slice(-2).reverse(),
  };
}

/* ============================================================
   Meeting panel
   ============================================================ */

// The anchor at the top of the tab: which meeting am I looking at, who defined
// it, and how do I change it or start another. Everything below is downstream
// of this, so it cannot be buried under the read.
function renderMeetingBar() {
  const host = document.getElementById('meetingBar');
  host.replaceChildren();
  const m = current();

  const bar = el('div', { class: 'meetingbar' });
  bar.append(el('div', { class: 'mb-top' }, [
    el('span', { class: 'mb-tag', text: m ? 'Meeting you are looking at' : 'No meeting yet' }),
    el('button', {
      class: 'btn ghost sm', type: 'button', text: '+ New',
      onclick: () => startNewMeeting(),
    }),
  ]));

  if (!m) {
    bar.append(el('p', {
      style: 'font-size:14px;line-height:1.55;margin:0;color:var(--text-secondary)',
      text: 'Start one and the read builds itself as you fill it in.',
    }));
    bar.append(el('div', { class: 'mb-actions' }, [
      el('button', { class: 'btn', type: 'button', text: 'Set up a meeting', onclick: () => startNewMeeting() }),
    ]));
    host.append(bar);
    return;
  }

  bar.append(el('h2', {
    class: 'mb-title' + (m.title.trim() ? '' : ' untitled'),
    text: m.title.trim() || 'Untitled meeting',
  }));
  bar.append(el('div', {
    class: 'mb-meta',
    text: [m.date || 'no date', fmtMins(m.minutes || 60), `${m.attendees.length} in the room`].join(' · '),
  }));
  bar.append(el('div', {
    class: 'mb-intent' + (m.outcome.trim() ? '' : ' none'),
    text: m.outcome.trim() ? `“${m.outcome.trim()}”` : 'No intended outcome written yet — that is what the read is measured against.',
  }));

  const listWrap = el('div', { class: 'mb-listwrap', hidden: 'hidden' }, [el('div', { id: 'meetingList' })]);
  const toggle = el('button', {
    class: 'btn ghost', type: 'button',
    text: `All meetings (${state.meetings.length})`,
    onclick: () => {
      listWrap.hidden = !listWrap.hidden;
      toggle.textContent = listWrap.hidden ? `All meetings (${state.meetings.length})` : 'Hide list';
    },
  });

  bar.append(el('div', { class: 'mb-actions' }, [
    el('button', {
      class: 'btn', type: 'button', text: 'Edit this meeting',
      onclick: () => jumpToDefine(),
    }),
    toggle,
  ]));
  bar.append(listWrap);
  host.append(bar);
}

function jumpToDefine() {
  const card = document.getElementById('defineCard');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('ping');
  void card.offsetWidth;
  card.classList.add('ping');
  setTimeout(() => document.getElementById('mTitle')?.focus({ preventScroll: true }), 380);
}

function startNewMeeting() {
  const m = newMeeting();
  state.meetings.push(m);
  state.currentId = m.id;
  save();
  showTab('meeting');
  renderMeeting();
  renderDebrief();
  jumpToDefine();
  toast('New meeting — give it a title and an intended outcome');
}

function renderMeetingList() {
  const host = document.getElementById('meetingList');
  if (!host) return;
  host.replaceChildren();
  if (!state.meetings.length) {
    host.append(el('div', { class: 'empty', text: 'No meetings yet. Hit New, or load the example on the Team tab.' }));
    return;
  }
  const sorted = [...state.meetings].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const m of sorted) {
    const a = analyze(m);
    const gaps = a.required.length && a.inRoom.length ? a.gaps.length : null;
    host.append(el('div', {
      class: 'meeting-item' + (m.id === state.currentId ? ' sel' : ''),
      onclick: () => { state.currentId = m.id; save(); renderMeeting(); renderDebrief(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    }, [
      el('div', {}, [
        el('div', { class: 'mi-t', text: m.title || 'Untitled meeting' }),
        el('div', { class: 'mi-s', text: `${m.date || 'no date'} · ${fmtMins(m.minutes || 60)} · ${m.attendees.length} in the room` }),
      ]),
      el('div', { class: 'mi-r' }, [
        gaps === null ? null
          : el('span', { class: `chip ${gaps ? 'critical' : 'good'}` }, [
              el('span', { class: 'dot' }), gaps ? `${gaps} gap${gaps > 1 ? 's' : ''}` : 'Fits',
            ]),
      ]),
    ]));
  }
}

// The shape is a choice the organizer made, stored on the meeting — not an
// inference from whatever types happen to be ticked. Editing a type below
// adjusts the shape; it does not silently throw it away.
const matchesShape = (m, arch) => arch.types.length === (m.required || []).length
  && arch.types.every((t) => m.required.includes(t));

function renderArchetypes() {
  const host = document.getElementById('archetypes');
  const note = document.getElementById('archNote');
  host.replaceChildren();
  note.replaceChildren();
  const m = current();
  if (!m) return;

  for (const arch of MODEL.archetypes) {
    const chosen = m.archetype === arch.id;
    host.append(el('button', {
      class: 'arch', type: 'button', 'aria-pressed': String(chosen),
      title: `${arch.example} — ${arch.types.map((t) => typeById(t).name).join(', ')}. Usually led by ${typeById(arch.lead).name}.`,
      onclick: () => {
        if (m.archetype === arch.id) {
          m.archetype = null;                    // tapping the chosen one clears it
        } else {
          m.archetype = arch.id;
          m.required = [...arch.types];
        }
        m.touched = true;
        save();
        renderMeeting();
      },
    }, [
      el('div', { class: 'a-n' }, [
        arch.name,
        chosen && !matchesShape(m, arch) ? el('span', { class: 'a-adj', text: 'adjusted' }) : null,
      ]),
      el('div', { class: 'a-a', text: `${arch.altLabel} · ${arch.types.map((t) => typeById(t).short).join(' ')}` }),
    ]));
  }

  const chosen = MODEL.archetypes.find((x) => x.id === m.archetype);
  if (!chosen) {
    note.textContent = 'No shape set — the types below are whatever you or the outcome text put there.';
    return;
  }
  if (matchesShape(m, chosen)) {
    note.textContent = `${chosen.name} — ${chosen.example.toLowerCase()}.`;
    return;
  }
  note.append(
    `${chosen.name}, adjusted. You have changed the types away from the default set. `,
    el('button', {
      class: 'linkbtn', type: 'button', text: `Put ${chosen.name} back`,
      onclick: () => { m.required = [...chosen.types]; save(); renderMeeting(); },
    }),
  );
}

function renderTypePicker() {
  const host = document.getElementById('typePicker');
  host.replaceChildren();
  const m = current();
  if (!m) return;

  const suggested = m.touched ? [] : suggestTypes(m.outcome);
  if (!m.touched && suggested.length) m.required = suggested.slice();

  for (const t of TYPES) {
    host.append(el('button', {
      class: 'typechip', type: 'button',
      'aria-pressed': String(m.required.includes(t.id)),
      title: `${t.desc} — ${t.mode}, ${t.altLabel}`,
      onclick: () => {
        m.touched = true;
        const i = m.required.indexOf(t.id);
        if (i >= 0) m.required.splice(i, 1); else m.required.push(t.id);
        save(); renderMeeting();
      },
    }, [
      el('div', { class: 'tc-name' }, [t.name, suggested.includes(t.id) ? el('span', { class: 'tc-sug', text: 'suggested' }) : null]),
      el('div', { class: 'tc-phase', text: `${MODEL.phases.find((p) => p.id === t.phase).name} · ${t.mode} · ${t.altLabel}` }),
    ]));
  }

  document.getElementById('sugNote').textContent = m.touched
    ? 'You have set these by hand. Changing the outcome text will not move them.'
    : suggested.length
      ? 'Suggested from your outcome text. Keyword matching, not judgement — override anything that looks wrong.'
      : 'Write an intended outcome above, pick a shape, or just choose them yourself.';
}

function renderAttendeePicker() {
  const host = document.getElementById('attendeePicker');
  host.replaceChildren();
  const m = current();
  if (!m) return;
  if (!state.people.length) {
    host.append(el('div', { class: 'empty', text: 'No people yet. Import a team on the Team tab.' }));
    return;
  }

  // A meeting is not owned by a team — pick from all of them, grouped so it is
  // obvious when you are reaching across.
  const picked = state.people.filter((p) => m.attendees.includes(p.id));
  const teamsUsed = [...new Set(picked.map((p) => p.team))];
  host.append(el('p', {
    class: 'hint', style: 'margin:0 0 12px',
    text: picked.length
      ? `${picked.length} in the room` + (teamsUsed.length > 1
          ? ` — across ${teamsUsed.map((t) => teamById(t)?.name || '?').join(', ')}.`
          : `, all ${teamById(teamsUsed[0])?.name || ''}.`)
      : 'Nobody picked yet. Tick anyone, from any team.',
  }));

  for (const t of state.teams) {
    const members = peopleOf(t.id);
    if (!members.length) continue;
    const inThis = members.filter((p) => m.attendees.includes(p.id)).length;

    const group = el('div', { class: 'teamgroup' });
    group.append(el('div', { class: 'tg-head' }, [
      el('span', { class: 'tg-name', text: t.name }),
      el('span', { class: 'tg-count', text: inThis ? `${inThis} of ${members.length}` : `${members.length}` }),
      el('button', {
        class: 'linkbtn', type: 'button',
        text: inThis === members.length ? 'none' : 'all',
        onclick: () => {
          const ids = members.map((p) => p.id);
          m.attendees = inThis === members.length
            ? m.attendees.filter((id) => !ids.includes(id))
            : [...new Set([...m.attendees, ...ids])];
          save(); renderMeeting(); renderDebrief(); renderLoad();
        },
      }),
    ]));

    for (const p of members) {
      const cb = el('input', { type: 'checkbox', ...(m.attendees.includes(p.id) ? { checked: 'checked' } : {}) });
      cb.addEventListener('change', () => {
        const i = m.attendees.indexOf(p.id);
        if (cb.checked && i < 0) m.attendees.push(p.id);
        if (!cb.checked && i >= 0) m.attendees.splice(i, 1);
        save(); renderMeeting(); renderDebrief(); renderLoad();
      });
      group.append(el('label', { class: 'checkline' }, [cb, el('div', {}, [
        el('div', { class: 'cl-name', text: p.name }),
        el('div', { class: 'cl-sub', text: geniusesOf(p).map((x) => x.name).join(' · ') }),
      ])]));
    }
    host.append(group);
  }
}


function renderCriteria() {
  const card = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'What a good meeting means here' }),
    el('p', { class: 'hint', style: 'margin:-6px 0 12px', text: 'The leader\'s call. Everything below is judged against this, not a generic model.' }),
  ]);
  const wrap = el('div', { class: 'crit-grid' });
  for (const c of MODEL.criteria || []) {
    const on = (state.criteria || []).includes(c.id);
    wrap.append(el('button', {
      class: 'critchip', type: 'button', 'aria-pressed': String(on), title: c.desc,
      onclick: () => {
        const arr = state.criteria || [];
        const i = arr.indexOf(c.id);
        if (i >= 0) arr.splice(i, 1); else arr.push(c.id);
        state.criteria = arr;
        save(); renderVerdict();
      },
    }, [
      el('div', { class: 'cc-n', text: c.name }),
      el('div', { class: 'cc-d', text: c.desc }),
    ]));
  }
  card.append(wrap);
  if (!(state.criteria || []).length) {
    card.append(el('p', { class: 'hint', text: 'Nothing picked — every type is weighted the same, which is nobody\'s actual view.' }));
  }
  return card;
}

function renderCriteriaRead(m, a) {
  const active = activeCriteria();
  if (!active.length) return null;
  const r = criteriaRisk(a);
  const card = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: `Against ${active.map((c) => c.name.toLowerCase()).join(' and ')}` }),
  ]);

  const pctAtRisk = Math.round(r.score * 100);
  card.append(el('div', { class: 'meter' }, [
    el('div', { class: 'meter-fill', style: `width:${Math.max(2, pctAtRisk)}%;background:${pctAtRisk >= 50 ? 'var(--status-critical)' : pctAtRisk >= 20 ? 'var(--status-warning)' : 'var(--status-good)'}` }),
  ]));
  card.append(el('p', {
    style: 'font-size:13px;color:var(--text-muted);margin:6px 0 14px',
    text: `${pctAtRisk}% of what you said matters is exposed in this room.`,
  }));

  if (r.worst) {
    card.append(el('p', { style: 'font-size:14.5px;line-height:1.6;margin:0;color:var(--text-secondary)' }, [
      'Of everything missing, ',
      el('strong', { style: 'color:var(--text-primary)', text: r.worst.type.name }),
      ` is the one that costs you most — it carries the heaviest weight under ${active.map((c) => c.name.toLowerCase()).join(' / ')}, and it is `,
      STATUS_LABEL[r.worst.status].toLowerCase(), '.',
    ]));
  } else {
    card.append(el('p', { style: 'font-size:14.5px;line-height:1.6;margin:0;color:var(--text-secondary)',
      text: 'Nothing this room is missing matters much to what you said you care about.' }));
  }

  if (loadAware()) {
    const strained = strainedAttendees(m, a);
    card.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:12px 0 0;color:var(--text-secondary)' },
      strained.length
        ? ['You said nobody burned. ', el('strong', { style: 'color:var(--text-primary)', text: strained.map((p2) => p2.name).join(', ') }),
           strained.length === 1 ? ' walks into this already past the line today.' : ' walk into this already past the line today.']
        : ['You said nobody burned. Nobody in this room is past the line today.']));
  }
  return card;
}

function renderForecast(m) {
  const f = forecast(m);
  const card = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'Forecast' }),
  ]);

  if (!f.ready) {
    card.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0;color:var(--text-muted)',
      text: `Learning from your debriefs. ${f.n} debriefed so far — ${f.needed} more and this starts predicting from your own results instead of the rules.` }));
    return card;
  }

  const pctv = Math.round(f.p * 100);
  card.append(el('div', { class: 'fc-top' }, [
    el('div', { class: 'fc-num', style: `color:${pctv >= 60 ? 'var(--status-good)' : pctv >= 35 ? 'var(--status-warning)' : 'var(--status-critical)'}`, text: `${pctv}%` }),
    el('div', { class: 'fc-cap', text: 'chance this meeting hits its stated outcome' }),
  ]));

  const lines = [];
  lines.push(`Learned from ${f.n} debriefed meeting${f.n === 1 ? '' : 's'} on this device`
    + (f.base !== null ? `, which hit their outcome ${Math.round(f.base * 100)}% of the time on average` : '') + '.');
  if (!f.confident) {
    lines.push(`That is not yet enough to trust on its own, so this is still leaning on the rules — treat it as a hint, not a number.`);
  }
  card.append(el('p', { style: 'font-size:13px;color:var(--text-muted);margin:10px 0 0;line-height:1.6', text: lines.join(' ') }));

  if (f.hurts.length) {
    card.append(el('h3', { class: 'section-title', style: 'margin:18px 0 6px', text: 'What is pulling it down' }));
    for (const h of f.hurts) {
      card.append(el('div', { class: 'fc-row' }, [
        el('span', { text: h.label }),
        el('span', { class: 'fc-bar' }, [el('span', { style: `width:${Math.min(100, Math.abs(h.v) * 90)}%;background:var(--status-critical)` })]),
      ]));
    }
  }
  if (f.helps.length) {
    card.append(el('h3', { class: 'section-title', style: 'margin:18px 0 6px', text: 'What is helping' }));
    for (const h of f.helps) {
      card.append(el('div', { class: 'fc-row' }, [
        el('span', { text: h.label }),
        el('span', { class: 'fc-bar' }, [el('span', { style: `width:${Math.min(100, Math.abs(h.v) * 90)}%;background:var(--status-good)` })]),
      ]));
    }
  }
  card.append(el('p', { class: 'privacy', text: 'Trained in this browser, on this device, from debriefs entered here. Nothing is sent anywhere, and it knows nothing about any other team.' }));
  return card;
}

function renderVerdict() {
  const host = document.getElementById('verdictCol');
  host.replaceChildren();
  const m = current();
  if (!m) { host.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: 'Pick or create a meeting.' })])); return; }

  const a = analyze(m);
  const ready = a.required.length && a.inRoom.length;

  const heroCard = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'The read' }),
    el('div', { class: 'hero' }, [
      el('div', { class: 'figure ' + (!ready ? '' : a.gaps.length ? 'bad' : 'good'), text: ready ? String(a.gaps.length) : '—' }),
      el('div', {
        class: 'cap',
        text: !ready ? 'Waiting on a meeting definition and at least one attendee.'
          : `thing${a.gaps.length === 1 ? '' : 's'} this meeting needs that the room cannot supply`,
      }),
    ]),
    el('p', { class: 'verdict-line', text: verdictSentence(a) }),
  ]);

  if (ready) heroCard.append(renderMoveBox(m, a));
  host.append(renderCriteria());
  host.append(renderModeChoice(m));
  host.append(heroCard);
  if (!ready) return;

  /* coverage */
  const cov = el('div', { class: 'card' }, [el('h2', { class: 'section-title', text: 'What the meeting needs, against who is here' })]);
  const ordered = activeCriteria().length ? criteriaRisk(a).ranked : a.coverage;
  for (const c of ordered) {
    const who = [];
    if (c.g.length) who.push(`energized: ${c.g.map((p) => p.name).join(', ')}`);
    if (c.c.length) who.push(`capable: ${c.c.map((p) => p.name).join(', ')}`);
    if (c.f.length) who.push(`drained: ${c.f.map((p) => p.name).join(', ')}`);
    cov.append(el('div', { class: 'cov-row' }, [
      el('div', {}, [
        el('div', { class: 'cr-head' }, [
          el('div', { class: 'cr-name', text: c.type.name }),
          el('span', { class: `chip ${c.status}` }, [el('span', { class: 'dot' }), STATUS_LABEL[c.status]]),
        ]),
        el('div', { class: 'cr-who', text: who.length ? who.join(' · ') : 'nobody in the room registers on this' }),
      ]),
    ]));
  }
  cov.append(tableView(['Type', 'Energized', 'Capable', 'Drained', 'Verdict'],
    a.coverage.map((c) => [c.type.name, c.g.length, c.c.length, c.f.length, STATUS_LABEL[c.status]])));
  host.append(cov);

  const critRead = renderCriteriaRead(m, a);
  if (critRead) host.append(critRead);
  host.append(renderForecast(m));
  host.append(renderComposition(a));

  if (a.idle.length || a.drained.length) {
    const mis = el('div', { class: 'card' }, [el('h2', { class: 'section-title', text: 'Fit of the people you invited' })]);
    if (a.idle.length) {
      mis.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0 0 10px;color:var(--text-secondary)' }, [
        el('strong', { style: 'color:var(--text-primary)', text: a.idle.map((p) => p.name).join(', ') }),
        a.idle.length === 1 ? ' has no genius this meeting uses. ' : ' have no genius this meeting uses. ',
        'Not a reason to disinvite — but if the invite was about coverage rather than stake, this is an hour you are spending for nothing.',
      ]));
    }
    if (a.drained.length) {
      mis.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0;color:var(--text-secondary)' }, [
        'This meeting sits in two frustrations for ',
        el('strong', { style: 'color:var(--text-primary)', text: a.drained.map((p) => p.name).join(', ') }),
        '. They can attend, but do not leave the meeting with them owning the follow-through.',
      ]));
    }
    host.append(mis);
  }

  host.append(renderAgenda(a));
}

const modeOf = (m) => (m && m.mode) || 'intent';

function renderModeChoice(m) {
  const card = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'What is allowed to move?' }),
  ]);
  const seg = el('div', { class: 'seg-wide' });
  for (const pm of MODEL.planningModes) {
    seg.append(el('button', {
      type: 'button',
      'aria-pressed': String(modeOf(m) === pm.id),
      text: pm.short,
      title: pm.desc,
      onclick: () => { m.mode = pm.id; save(); renderVerdict(); },
    }));
  }
  card.append(seg);
  const pm = MODEL.planningModes.find((x) => x.id === modeOf(m));
  card.append(el('p', {
    style: 'font-size:13.5px;line-height:1.6;margin:12px 0 0;color:var(--text-secondary)',
    text: pm.desc,
  }));
  return card;
}

// The advice depends entirely on which variable the organizer has freed.
function renderMoveBox(m, a) {
  const box = el('div', { class: 'fix' });

  if (modeOf(m) === 'intent') {
    if (!a.gaps.length) {
      box.append(el('div', {}, ['This room can produce the outcome as written. Nothing to change.']));
      if (a.idle.length) {
        box.append(el('div', { style: 'margin-top:8px' }, [
          'You could give ', el('strong', { text: a.idle.map((p) => p.name).join(', ') }),
          ' the hour back — nothing this outcome needs uses their genius.',
        ]));
      }
      return box;
    }
    const mr = minimumRoster(a);
    box.append(el('div', { style: 'margin-bottom:8px;color:var(--text-primary);font-weight:620' },
      ['To get this outcome, the room has to change.']));
    for (const pick of mr.picks) {
      box.append(el('div', {}, [
        'Add ', el('strong', { text: `${pick.person.name} (${teamName(pick.person)})` }),
        ` — covers ${pick.covers.map((t) => t.name).join(' and ')}.`,
      ]));
    }
    for (const t of mr.stillMissing) {
      box.append(el('div', {}, [
        'Nobody on this team carries ', el('strong', { text: t.name }),
        '. No invite list fixes this one — that work has to come from outside the team, or the outcome has to change.',
      ]));
    }
    if (a.idle.length) {
      box.append(el('div', { style: 'margin-top:8px' }, [
        'You can drop ', el('strong', { text: a.idle.map((p) => p.name).join(', ') }),
        ' without cost to this outcome.',
      ]));
    }
    return box;
  }

  /* people are fixed — reshape the meeting instead */
  const rs = reshape(a);
  if (!rs.cannot.length) {
    box.append(el('div', {}, ['This room can run the meeting as written. No reshaping needed.']));
    return box;
  }
  box.append(el('div', { style: 'margin-bottom:8px;color:var(--text-primary);font-weight:620' },
    ['Keep the people, change the meeting.']));
  if (rs.canDo.length) {
    box.append(el('div', {}, [
      'This room can carry ', el('strong', { text: rs.canDo.map((t) => t.name).join(' and ') }),
      '. Run that much and stop there.',
    ]));
  }
  box.append(el('div', {}, [
    'Take ', el('strong', { text: rs.cannot.map((t) => t.name).join(' and ') }),
    ' off this agenda — it will not happen in this room however long you sit there. Book it separately with someone who carries it.',
  ]));
  if (rs.best && rs.best.score > 0) {
    box.append(el('div', { style: 'margin-top:8px' }, [
      'What this room is actually built for: the ',
      el('strong', { text: rs.best.ar.name }),
      ` shape at ${rs.best.ar.altLabel} — ${rs.best.ar.example.toLowerCase()}.`,
    ]));
  }
  box.append(el('div', { style: 'margin-top:8px' }, [
    'Rewrite the intended outcome to promise only what this room can deliver, so nobody leaves thinking the rest got handled.',
  ]));
  return box;
}

function renderComposition(a) {
  const c = a.composition;
  const card = el('div', { class: 'card' }, [el('h2', { class: 'section-title', text: 'How the room is built' })]);

  if (c.total) {
    card.append(el('div', { class: 'split' }, [
      el('div', { class: 'sp' }, [
        el('div', { class: 'sp-n', text: 'Responsive' }),
        el('div', { class: 'sp-v', text: String(c.responsive) }),
        el('div', { class: 'sp-w', text: 'geniuses that react to what is already moving' }),
      ]),
      el('div', { class: 'sp' }, [
        el('div', { class: 'sp-n', text: 'Disruptive' }),
        el('div', { class: 'sp-v', text: String(c.disruptive) }),
        el('div', { class: 'sp-w', text: 'geniuses that push change onto other people' }),
      ]),
    ]));
    if (c.modeVerdict) {
      card.append(el('div', { class: 'row', style: 'margin-bottom:8px' }, [
        el('span', { class: `chip ${c.modeVerdict.status}` }, [el('span', { class: 'dot' }), c.modeVerdict.status === 'good' ? 'Balanced' : 'Skewed']),
      ]));
      card.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0;color:var(--text-secondary)', text: c.modeVerdict.text }));
    }
  }

  if (c.mAlt !== null) {
    const scale = el('div', { class: 'alt-scale' });
    const posOf = (alt) => ((alt - 1) / (TYPES.length - 1)) * 100;
    scale.append(el('div', { class: 'rule' }));
    scale.append(el('div', {
      class: 'band',
      style: `left:${Math.max(0, posOf(c.mAlt - 1))}%; width:${Math.min(100, posOf(c.mAlt + 1) - Math.max(0, posOf(c.mAlt - 1)))}%`,
      title: 'Where this meeting flies',
    }));
    for (const x of c.people) {
      scale.append(el('div', {
        class: 'pin ' + (Math.abs(x.alt - c.mAlt) >= 2 ? 'off' : 'ok'),
        style: `left:${posOf(x.alt)}%`,
        title: `${x.p.name} — flies around ${TYPES[Math.round(x.alt) - 1]?.altLabel || ''}`,
      }));
    }
    card.append(el('h3', { class: 'section-title', style: 'margin:22px 0 0', text: 'Altitude' }));
    card.append(scale);
    card.append(el('div', { class: 'alt-ends' }, [
      el('span', { text: `${TYPES[0].altLabel} — ${TYPES[0].name}` }),
      el('span', { text: `${TYPES[TYPES.length - 1].altLabel} — ${TYPES[TYPES.length - 1].name}` }),
    ]));

    const lines = [];
    if (c.high.length) lines.push(`${c.high.map((x) => x.p.name).join(', ')} ${c.high.length === 1 ? 'flies' : 'fly'} well above this meeting. Expect ${c.high.length === 1 ? 'them' : 'them'} to reopen the question the meeting was supposed to be past.`);
    if (c.low.length) lines.push(`${c.low.map((x) => x.p.name).join(', ')} ${c.low.length === 1 ? 'works' : 'work'} well below it, and will push for specifics the meeting is not ready to give.`);
    card.append(el('p', {
      style: 'font-size:13.5px;line-height:1.6;margin:12px 0 0;color:var(--text-secondary)',
      text: lines.length ? lines.join(' ') : 'Everyone in the room flies at roughly the altitude this meeting needs.',
    }));
  }
  return card;
}

function renderAgenda(a) {
  const card = el('div', { class: 'card' }, [el('h2', { class: 'section-title', text: 'Suggested shape' })]);
  const list = el('ol', { class: 'agenda' });
  let n = 0;

  for (const phase of MODEL.phases) {
    const types = a.required.filter((t) => t.phase === phase.id);
    if (!types.length) continue;
    n += 1;
    const byType = types.map((t) => ({ t, leads: a.inRoom.filter((p) => levelsOf(p, t.id) === 'g') }));
    const led = byType.filter((x) => x.leads.length);
    const unled = byType.filter((x) => !x.leads.length);

    let body = `${phase.desc}. `;
    if (led.length) body += `${led.map((x) => `${x.t.name} belongs to ${x.leads.map((p) => p.name).join(' or ')}`).join('; ')}. `;
    if (unled.length) body += `Nobody in the room leads ${unled.map((x) => x.t.name).join(' or ')} — give it a named owner and a hard time box, or the meeting drifts past it.`;

    list.append(el('li', { class: 'ag-item' }, [
      el('div', { class: 'num', text: String(n) }),
      el('div', {}, [
        el('div', { class: 'ag-h' }, [
          phase.name,
          el('span', { style: 'font-weight:450;color:var(--text-muted);font-size:12.5px' }, types.map((t) => t.name).join(' + ')),
          unled.length ? el('span', { class: 'chip critical' }, [el('span', { class: 'dot' }),
            unled.length === byType.length ? 'No lead' : `No lead for ${unled.map((x) => x.t.name).join(', ')}`]) : null,
        ]),
        el('div', { class: 'ag-b', text: body }),
      ]),
    ]));
  }

  if (!n) { card.append(el('div', { class: 'empty', text: 'Pick at least one type and the shape will build itself.' })); return card; }
  card.append(list);
  card.append(el('p', {
    style: 'font-size:13px;color:var(--text-muted);margin:14px 0 0;line-height:1.6',
    text: a.required.some((t) => t.phase === 'implementation')
      ? 'Close by naming who owns the finish, out loud, before anyone leaves.'
      : 'This meeting has no implementation type in it. That is fine — but it means nothing here is going to get finished, so do not let it end feeling like something did.',
  }));
  return card;
}

function renderMeeting() {
  const m = current();
  document.getElementById('mTitle').value = m ? m.title : '';
  document.getElementById('mOutcome').value = m ? m.outcome : '';
  document.getElementById('mDate').value = m ? (m.date || '') : '';
  document.getElementById('mMinutes').value = m ? String(m.minutes || 60) : '60';
  renderMeetingBar();
  renderMeetingList();
  renderArchetypes();
  renderTypePicker();
  renderAttendeePicker();
  renderVerdict();
}

/* ============================================================
   Load panel
   ============================================================ */

function renderLoad() {
  const host = document.getElementById('loadPanel');
  host.replaceChildren();
  const v = viewer();
  if (!v) { host.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: 'Add a team first.' })])); return; }

  host.append(viewerBar(isLeader()
    ? 'Your own week in full, plus the team in aggregate.'
    : 'Only this person sees this. It is not visible to whoever runs the team.'));

  const dates = weekDates();
  const today = isoDate(new Date());
  const todayIdx = dates.indexOf(today);
  const focusDate = todayIdx >= 0 ? today : dates[2];
  const dayL = dayLoad(v, focusDate);
  const face = faceFor(dayL, 1);
  const wk = weekLoad(v, dates);

  /* --- personal: hero --- */
  const hero = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: `${v.name} — ${focusDate === today ? 'today' : focusDate}` }),
    el('div', { class: 'face-hero' }, [
      faceSVG(face.status, face.id, true),
      el('div', {}, [
        el('div', { class: 'fh-lab', text: face.name }),
        el('div', { class: 'fh-sub', text: face.line }),
      ]),
      el('div', { class: 'fh-right' }, [
        el('div', { class: 'fh-num', style: `color:var(--status-${face.status === 'neutral' ? 'good' : face.status})`, text: pct(face.fp) }),
        el('div', { style: 'font-size:12.5px;color:var(--text-muted);line-height:1.35', text: 'of the day in draining work' }),
      ]),
    ]),
    el('p', {
      style: 'font-size:13.5px;line-height:1.6;margin:16px 0 0;padding-top:16px;border-top:1px solid var(--gridline);color:var(--text-secondary)',
      text: dayL.minutes === 0
        ? 'Nothing tracked on this day.'
        : `${fmtMins(dayL.minutes)} of tracked meetings — ${fmtMins(dayL.g)} energizing, ${fmtMins(dayL.c)} competent, ${fmtMins(dayL.f)} draining. Against an ${MODEL.load.workdayMinutes / 60}-hour day.`,
    }),
  ]);

  if (dayL.meetings.length) {
    const rows = el('div', { style: 'margin-top:14px' });
    for (const m of dayL.meetings) {
      const s = meetingSplit(v, m);
      const dominant = s.f > s.g && s.f > s.c ? 'draining' : s.g >= s.c && s.g >= s.f ? 'energizing' : 'competent';
      rows.append(el('div', { class: 'load-row' }, [
        el('div', {}, [
          el('div', { class: 'lr-t', text: m.title || 'Untitled' }),
          el('div', { class: 'lr-s', text: `${(m.required || []).map((id) => typeById(id)?.name).filter(Boolean).join(' + ') || 'no types set'}${s.reported ? ' · as reported' : ''}` }),
        ]),
        el('div', { class: 'lr-v', text: `${fmtMins(m.minutes || 60)} · ${dominant}` }),
      ]));
    }
    hero.append(rows);
  }
  host.append(hero);

  /* --- personal: the week --- */
  const week = el('div', { class: 'card', style: 'margin-top:18px' }, [
    el('h2', { class: 'section-title', text: 'The week' }),
  ]);
  const strip = el('div', { class: 'week' });
  dates.forEach((d, i) => {
    const l = dayLoad(v, d);
    const f = faceFor(l, 1);
    strip.append(el('div', { class: 'day' + (d === today ? ' today' : '') }, [
      el('div', { class: 'd-n', text: DAY_NAMES[i] }),
      el('div', { class: 'd-f' }, [faceSVG(f.status, f.id)]),
      el('div', { class: 'd-v', text: l.minutes ? fmtMins(l.minutes) : '—' }),
      el('div', { class: 'd-m', text: l.minutes ? `${pct(f.fp)} draining` : 'clear' }),
    ]));
  });
  week.append(strip);
  week.append(el('h3', { class: 'section-title', style: 'margin:22px 0 6px', text: 'Mix of tracked time' }));
  week.append(mixBar(wk));
  week.append(el('div', { class: 'legend', style: 'margin-top:10px' }, MODEL.levels.map((l) =>
    el('div', { class: 'lg' }, [
      el('span', { class: 'sw', style: `background:${l.id === 'g' ? 'var(--div-pos)' : l.id === 'f' ? 'var(--div-neg)' : 'var(--baseline)'}` }),
      `${l.name} — ${wk.g + wk.c + wk.f > 0 ? pct((l.id === 'g' ? wk.g : l.id === 'c' ? wk.c : wk.f) / (wk.g + wk.c + wk.f)) : '0%'}`,
    ]))));
  week.append(tableView(['Day', 'Tracked', 'Energizing', 'Competent', 'Draining'],
    dates.map((d, i) => {
      const l = dayLoad(v, d);
      return [DAY_NAMES[i], fmtMins(l.minutes), fmtMins(l.g), fmtMins(l.c), fmtMins(l.f)];
    })));
  host.append(week);

  /* --- leader: aggregate only --- */
  if (isLeader()) host.append(renderLeaderBlock(dates));

  host.append(el('p', {
    class: 'privacy',
    text: isLeader()
      ? 'You are seeing your own load in detail, and the team only in aggregate. Individual faces belong to the person they describe — a per-person burnout score a manager can read changes what people are willing to enter honestly, and then the number stops being true.'
      : 'This is yours. The person running the team sees how many people are over the line and which meetings are driving it — not your name against a face.',
  }));
}

function renderLeaderBlock(dates) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' }, [
    el('h2', { class: 'section-title', text: 'The team this week — aggregate' }),
  ]);

  // Burnout is a day, not an average. A week average buries the Wednesday
  // that actually broke someone, so count days past the line, not weeks.
  let over = 0, heavy = 0, badDays = 0;
  const teamTot = { g: 0, c: 0, f: 0, minutes: 0 };
  for (const p of state.people) {
    let worst = 'fine';
    for (const d of dates) {
      const l = dayLoad(p, d);
      teamTot.g += l.g; teamTot.c += l.c; teamTot.f += l.f; teamTot.minutes += l.minutes;
      const f = faceFor(l, 1);
      if (f.id === 'strained') { worst = 'strained'; badDays += 1; }
      else if (f.id === 'heavy' && worst !== 'strained') worst = 'heavy';
    }
    if (worst === 'strained') over += 1;
    else if (worst === 'heavy') heavy += 1;
  }

  card.append(el('div', { class: 'split' }, [
    el('div', { class: 'sp' }, [
      el('div', { class: 'sp-n', text: 'Past the line' }),
      el('div', { class: 'sp-v', style: over ? 'color:var(--status-critical)' : '', text: `${over}` }),
      el('div', { class: 'sp-w', text: `of ${state.people.length} people had a day over ${pct(MODEL.load.thresholds.frustrationStrained)} draining — ${badDays} such day${badDays === 1 ? '' : 's'} this week` }),
    ]),
    el('div', { class: 'sp' }, [
      el('div', { class: 'sp-n', text: 'Getting heavy' }),
      el('div', { class: 'sp-v', style: heavy ? 'color:var(--status-warning)' : '', text: `${heavy}` }),
      el('div', { class: 'sp-w', text: `worst day over ${pct(MODEL.load.thresholds.frustrationHeavy)}, not past the line` }),
    ]),
  ]));

  /* which meetings generate the most draining time, across everyone */
  const ranked = state.meetings
    .filter((m) => dates.includes(m.date))
    .map((m) => ({
      m,
      f: state.people.filter((p) => m.attendees.includes(p.id)).reduce((s, p) => s + meetingSplit(p, m).f, 0),
    }))
    .filter((x) => x.f > 0)
    .sort((a, b) => b.f - a.f)
    .slice(0, 5);

  if (ranked.length) {
    card.append(el('h3', { class: 'section-title', style: 'margin:22px 0 4px', text: 'Meetings generating the most draining time' }));
    const max = ranked[0].f;
    const bars = el('div', { class: 'bars' });
    for (const x of ranked) {
      bars.append(el('div', { class: 'bar-row', title: `${fmtMins(x.f)} of draining time across everyone in the room` }, [
        el('div', { class: 'bl', text: x.m.title || 'Untitled' }),
        el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', style: `width:${(x.f / max) * 100}%` })]),
        el('div', { class: 'bv', text: fmtMins(x.f) }),
      ]));
    }
    card.append(bars);
    card.append(el('p', {
      style: 'font-size:13px;color:var(--text-muted);margin:14px 0 0;line-height:1.6',
      text: 'Person-hours of draining work each meeting creates. This is the list to shorten, re-shape or stop inviting people to — it is a property of the meeting, not of anybody in it.',
    }));
    card.append(tableView(['Meeting', 'Date', 'Draining person-time'],
      ranked.map((x) => [x.m.title || 'Untitled', x.m.date || '—', fmtMins(x.f)])));
  }

  card.append(el('h3', { class: 'section-title', style: 'margin:22px 0 6px', text: 'Whole team, mix of tracked time' }));
  card.append(mixBar(teamTot));
  return card;
}

/* ============================================================
   Debrief panel
   ============================================================ */

function renderDebrief() {
  const host = document.getElementById('debriefPanel');
  host.replaceChildren();
  const v = viewer();
  const m = current();

  if (!v || !m) {
    host.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: 'Pick a meeting on the Meeting tab first.' })]));
    return;
  }

  host.append(viewerBar('Answering for this person. Switch to fill in someone else.'));
  if (!m.attendees.includes(v.id)) {
    host.append(el('div', { class: 'card' }, [
      el('h2', { class: 'section-title', text: m.title || 'Untitled meeting' }),
      el('div', { class: 'empty', text: `${v.name} was not in this meeting. Switch who you are viewing as, or pick another meeting.` }),
    ]));
    host.append(renderDebriefSummary(m));
    return;
  }

  m.debriefs = m.debriefs || {};
  const d = m.debriefs[v.id] = m.debriefs[v.id] || { felt: null, outcome: null, note: '', obs: {} };

  const wrap = el('div', { class: 'cols' });
  const form = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: `Debrief — ${m.title || 'Untitled'}` }),
    el('p', { style: 'font-size:13px;color:var(--text-muted);margin:0 0 18px;line-height:1.55', text: `${m.date || 'no date'} · ${fmtMins(m.minutes || 60)} · answering as ${v.name}` }),
  ]);

  form.append(el('div', { class: 'field' }, [
    el('span', { style: 'display:block;font-size:12.5px;font-weight:550;color:var(--text-secondary);margin-bottom:6px', text: 'How did that hour feel?' }),
    segWide(MODEL.debrief.felt, d.felt, (id) => { d.felt = d.felt === id ? null : id; save(); renderDebrief(); renderLoad(); }),
    el('p', { style: 'font-size:12px;color:var(--text-muted);margin:6px 0 0;line-height:1.45', text: 'This overrides the prediction in your load tracker — what happened beats what your profile expected.' }),
  ]));

  form.append(el('div', { class: 'field', style: 'margin-top:18px' }, [
    el('span', { style: 'display:block;font-size:12.5px;font-weight:550;color:var(--text-secondary);margin-bottom:6px', text: 'Did it get the outcome?' }),
    m.outcome ? el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin:0 0 8px;line-height:1.5;font-style:italic', text: `“${m.outcome}”` }) : null,
    segWide(MODEL.debrief.outcome, d.outcome, (id) => { d.outcome = d.outcome === id ? null : id; save(); renderDebrief(); }),
  ]));

  const noteInput = el('textarea', { rows: '2', placeholder: 'One line — what would you change next time?' });
  noteInput.value = d.note || '';
  noteInput.addEventListener('input', () => { d.note = noteInput.value; save(); });
  form.append(el('label', { class: 'field', style: 'margin-top:18px' }, [
    el('span', { text: 'Change next time' }), noteInput,
  ]));

  wrap.append(form);

  /* observations */
  const others = state.people.filter((p) => m.attendees.includes(p.id) && p.id !== v.id);
  const obs = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'What you noticed about others' }),
  ]);
  if (!others.length) {
    obs.append(el('div', { class: 'empty', text: 'Nobody else was in this one.' }));
  } else {
    for (const p of others) {
      d.obs[p.id] = d.obs[p.id] || [];
      const tags = el('div', { class: 'obs-tags' });
      for (const t of MODEL.debrief.observationTags) {
        tags.append(el('button', {
          class: 'obs-tag', type: 'button', title: t.desc,
          'aria-pressed': String(d.obs[p.id].includes(t.id)),
          text: t.name,
          onclick: () => {
            const arr = d.obs[p.id];
            const i = arr.indexOf(t.id);
            if (i >= 0) arr.splice(i, 1); else arr.push(t.id);
            save(); renderDebrief();
          },
        }));
      }
      obs.append(el('div', { style: 'padding:11px 0;border-bottom:1px solid var(--gridline)' }, [
        el('div', { class: 'cl-name', style: 'margin-bottom:7px', text: p.name }),
        tags,
      ]));
    }
    obs.append(el('p', { class: 'privacy', text: 'Your observations stay yours. What the wider team sees is the count — how many people were noticed as underused or run over — never who said it about whom.' }));
  }
  wrap.append(obs);
  host.append(wrap);
  host.append(renderDebriefSummary(m));
}

function segWide(options, value, onPick) {
  const seg = el('div', { class: 'seg-wide' });
  for (const o of options) {
    seg.append(el('button', {
      type: 'button', 'data-st': o.status, 'aria-pressed': String(value === o.id),
      text: o.name, onclick: () => onPick(o.id),
    }));
  }
  return seg;
}

function renderDebriefSummary(m) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' }, [
    el('h2', { class: 'section-title', text: 'What the room reported' }),
  ]);
  const ds = Object.entries(m.debriefs || {}).filter(([pid]) => byId(pid));
  const inRoom = state.people.filter((p) => m.attendees.includes(p.id));

  if (!ds.length) {
    card.append(el('div', { class: 'empty', text: `No debriefs in yet — ${inRoom.length} people to hear from.` }));
    return card;
  }

  const count = (field, id) => ds.filter(([, d]) => d[field] === id).length;

  card.append(el('div', { class: 'row', style: 'gap:8px;margin-bottom:14px' },
    MODEL.debrief.outcome.map((o) => el('span', { class: `chip ${o.status}` }, [
      el('span', { class: 'dot' }), `${o.name}: ${count('outcome', o.id)}`,
    ]))));

  /* prediction vs reality — the loop that makes the tool worth keeping */
  const a = analyze(m);
  const predictedDrained = new Set(a.drained.map((p) => p.id));
  const reportedDrained = ds.filter(([, d]) => d.felt === 'draining').map(([pid]) => pid);
  const surprises = reportedDrained.filter((pid) => !predictedDrained.has(pid));
  const spared = [...predictedDrained].filter((pid) => {
    const d = (m.debriefs || {})[pid];
    return d && d.felt && d.felt !== 'draining';
  });

  const lines = [];
  lines.push(`${reportedDrained.length} of ${ds.length} who answered found it draining; the profiles predicted ${predictedDrained.size}.`);
  if (surprises.length) lines.push(`${surprises.map((id) => byId(id).name).join(', ')} found it draining and the model did not see it coming — worth asking why.`);
  if (spared.length) lines.push(`${spared.map((id) => byId(id).name).join(', ')} came out better than predicted.`);
  card.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0;color:var(--text-secondary)', text: lines.join(' ') }));

  /* observation counts only — never who said it */
  const tally = {};
  for (const [, d] of ds) {
    for (const arr of Object.values(d.obs || {})) for (const t of arr) tally[t] = (tally[t] || 0) + 1;
  }
  const tagged = MODEL.debrief.observationTags.filter((t) => tally[t.id]);
  if (tagged.length) {
    card.append(el('h3', { class: 'section-title', style: 'margin:22px 0 8px', text: 'Noticed by the room' }));
    card.append(el('div', { class: 'row', style: 'gap:8px' },
      tagged.map((t) => el('span', { class: 'chip', title: t.desc }, [`${t.name} × ${tally[t.id]}`]))));
  }

  const notes = ds.map(([, d]) => d.note).filter((n) => n && n.trim());
  if (notes.length) {
    card.append(el('h3', { class: 'section-title', style: 'margin:22px 0 8px', text: 'Change next time' }));
    for (const n of notes) {
      card.append(el('p', { style: 'font-size:13.5px;line-height:1.6;margin:0 0 8px;color:var(--text-secondary)', text: `“${n}”` }));
    }
  }
  return card;
}

/* ============================================================
   Team + profile panels
   ============================================================ */

function renderAddTeamSelect() {
  const sel = document.getElementById('addTeam');
  if (!sel) return;
  const want = state.teamFilter === 'all' ? (state.teams[0]?.id || '') : state.teamFilter;
  sel.replaceChildren();
  for (const t of state.teams) {
    sel.append(el('option', { value: t.id, ...(t.id === want ? { selected: 'selected' } : {}) }, [t.name]));
  }
  if (!state.teams.length) sel.append(el('option', { value: '' }, ['(create a team first)']));
}

const addTeamId = () => {
  const sel = document.getElementById('addTeam');
  const id = sel?.value || (state.teamFilter === 'all' ? state.teams[0]?.id : state.teamFilter);
  if (id && teamById(id)) return id;
  const t = { id: uid('t'), name: `Team ${state.teams.length + 1}` };
  state.teams.push(t);
  return t.id;
};

function addTeam() {
  const raw = prompt('Name the new team');
  if (raw === null) return;
  const name = raw.trim();
  if (!name) return;
  if (state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    toast('That team already exists');
    return;
  }
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || uid('t');
  if (state.teams.some((t) => t.id === id)) id = uid('t');
  state.teams.push({ id, name });
  state.teamFilter = id;
  save(); renderAll();
  toast(`${name} created — add people to it below`);
}

function renderTeamSwitcher() {
  const host = document.getElementById('teamSwitch');
  if (!host) return;
  host.replaceChildren();
  if (!state.teams.length) return;

  const mk = (id, label, count) => el('button', {
    class: 'teamchip', type: 'button', 'aria-pressed': String(state.teamFilter === id),
    onclick: () => { state.teamFilter = id; save(); renderRoster(); renderTeamViz(); renderTeamSwitcher(); renderAddTeamSelect(); },
  }, [label, el('span', { class: 'tc-count', text: String(count) })]);

  for (const t of state.teams) host.append(mk(t.id, t.name, peopleOf(t.id).length));
  host.append(mk('all', 'All', state.people.length));
}

function renderRoster() {
  const host = document.getElementById('roster');
  host.replaceChildren();
  const shown = peopleOf(state.teamFilter);
  document.getElementById('teamCount').textContent = String(state.people.length);
  document.getElementById('teamCount2').textContent = shown.length ? `· ${shown.length}` : '';
  if (!shown.length) {
    host.append(el('div', { class: 'empty', text: 'Nobody on this team yet. Import one below.' }));
    return;
  }
  for (const p of shown) {
    host.append(el('div', { class: 'person' }, [
      el('div', {}, [
        el('div', { class: 'pname' }, [
          p.name,
          state.teamFilter === 'all' ? el('span', { class: 'teambadge', text: teamName(p) }) : null,
          p.id === state.leaderId ? el('span', { style: 'font-size:11px;color:var(--text-muted);font-weight:450', text: ' · runs the team' }) : null,
        ]),
        el('div', { class: 'pgen', text: geniusesOf(p).map((t) => t.name).join(' · ') }),
      ]),
      el('button', {
        class: 'pdel', type: 'button', text: 'Remove',
        onclick: () => {
          state.people = state.people.filter((x) => x.id !== p.id);
          for (const m of state.meetings) m.attendees = m.attendees.filter((id) => id !== p.id);
          if (state.viewerId === p.id) state.viewerId = state.people[0]?.id || null;
          save(); renderAll();
        },
      }),
    ]));
  }
}

function renderTeamViz() {
  const host = document.getElementById('teamViz');
  host.replaceChildren();
  const roster = peopleOf(state.teamFilter);
  const label = state.teamFilter === 'all' ? 'everyone' : teamById(state.teamFilter)?.name || '';
  if (!roster.length) {
    host.append(el('div', { class: 'card' }, [el('div', { class: 'empty', text: 'The team picture appears once someone is on it.' })]));
    return;
  }

  const counts = TYPES.map((t) => ({ t, n: roster.filter((p) => levelsOf(p, t.id) === 'g').length }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  const bars = el('div', { class: 'bars' });
  for (const c of counts) {
    bars.append(el('div', { class: 'bar-row', title: `${c.n} of ${roster.length} energized by ${c.t.name}` }, [
      el('div', { class: 'bl', text: c.t.name }),
      el('div', { class: 'bar-track' }, [el('div', {
        class: 'bar-fill' + (c.n === 0 ? ' zero' : ''),
        style: `width:${c.n === 0 ? 3 : Math.round((c.n / max) * 100)}%`,
      })]),
      el('div', { class: 'bv', text: String(c.n) }),
    ]));
  }
  const zero = counts.filter((c) => c.n === 0);

  host.append(el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: state.teamFilter === 'all' ? 'Where everyone gains energy' : `Where ${label} gains energy` }),
    el('p', { style: 'font-size:13px;color:var(--text-secondary);margin:0 0 16px;line-height:1.55', text: `People energized by each type, out of ${roster.length} in ${label}.` }),
    bars,
    zero.length ? el('div', { class: 'fix' }, ['Nobody here is energized by ',
      el('strong', { text: zero.map((c) => c.t.name).join(' or ') }),
      '. Any meeting that needs it will stall at that point, every time, no matter who is in the room.']) : null,
    tableView(['Type', 'Phase', 'Mode', 'Energized', 'Drained'], TYPES.map((t) => [
      t.name, MODEL.phases.find((p) => p.id === t.phase).name, t.mode,
      roster.filter((p) => levelsOf(p, t.id) === 'g').length,
      roster.filter((p) => levelsOf(p, t.id) === 'f').length,
    ])),
  ]));

  const mx = el('div', { class: 'matrix', style: `grid-template-columns: minmax(96px, 1.4fr) repeat(${TYPES.length}, 1fr)` });
  mx.append(el('div', { class: 'mx-head' }));
  for (const t of TYPES) mx.append(el('div', { class: 'mx-head', text: t.short, title: `${t.name} — ${t.mode}, ${t.altLabel}` }));
  for (const p of roster) {
    mx.append(el('div', { class: 'mx-name', text: p.name }));
    for (const t of TYPES) {
      const lv = levelsOf(p, t.id);
      mx.append(el('div', {
        class: 'mx-cell', 'data-lvl': lv, text: lv.toUpperCase(),
        title: `${p.name} — ${t.name}: ${MODEL.levels.find((l) => l.id === lv).name}`,
      }));
    }
  }
  host.append(el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: state.teamFilter === 'all' ? 'Everyone, cell by cell' : `${label}, cell by cell` }),
    el('div', { class: 'matrix-scroll' }, [mx]),
    el('div', { class: 'legend' }, MODEL.levels.map((l) => el('div', { class: 'lg' }, [el('span', { class: `sw ${l.id}` }), `${l.short} — ${l.name}`]))),
  ]));
}

function renderMe() {
  const host = document.getElementById('meLevels');
  host.replaceChildren();
  document.getElementById('meName').value = state.me.name;

  for (const [i, t] of TYPES.entries()) {
    const seg = el('div', { class: 'seg' });
    for (const lv of MODEL.levels) {
      seg.append(el('button', {
        type: 'button', 'data-lvl': lv.id, text: lv.short,
        'aria-pressed': String(state.me.levels[i] === lv.id),
        title: `${t.name}: ${lv.desc}`,
        onclick: () => {
          const arr = [...state.me.levels]; arr[i] = lv.id;
          state.me.levels = arr.join(''); save(); renderMe();
        },
      }));
    }
    host.append(el('div', { class: 'lvl-row' }, [
      el('div', {}, [el('div', { class: 'tname', text: t.name }), el('div', { class: 'tphase', text: t.desc })]),
      seg,
    ]));
  }

  const got = { g: 0, c: 0, f: 0 };
  for (const ch of state.me.levels) got[ch] += 1;
  const ok = validLevels(state.me.levels) && state.me.name.trim().length > 0;
  const tally = document.getElementById('meTally');
  tally.textContent = `Genius ${got.g}/${MODEL.perPerson.g} · Competency ${got.c}/${MODEL.perPerson.c} · Frustration ${got.f}/${MODEL.perPerson.f}`
    + (state.me.name.trim() ? '' : ' — add your name');
  tally.className = 'tally' + (ok ? '' : ' bad');
  document.getElementById('meCopyBtn').disabled = !ok;
  document.getElementById('meAddBtn').disabled = !ok;
  document.getElementById('meCode').textContent = ok
    ? encodeProfile({ name: state.me.name.trim(), levels: state.me.levels })
    : 'Set exactly two of each above, and add your name.';
}

/* ============================================================
   Bulk import — read a pasted team report
   ============================================================ */

const LETTER_MAP = {
  w: 'wonder', wo: 'wonder',
  i: 'invention', in: 'invention', inv: 'invention',
  d: 'discernment', di: 'discernment', dis: 'discernment',
  g: 'galvanizing', ga: 'galvanizing', gal: 'galvanizing',
  e: 'enablement', en: 'enablement', ena: 'enablement',
  t: 'tenacity', te: 'tenacity', ten: 'tenacity',
};

const LABEL_RE = /(working\s+)?(genius(?:es)?|competenc(?:y|ies)|frustration(?:s)?)\b|\bwg\b|\bwc\b|\bwf\b/gi;

function labelBucket(match) {
  const s = match.toLowerCase();
  if (s.includes('genius') || s === 'wg') return 'g';
  if (s.includes('competenc') || s === 'wc') return 'c';
  return 'f';
}

// every full type name mentioned, in the order it appears
function nameMentions(line) {
  const lower = line.toLowerCase();
  const out = [];
  for (const t of TYPES) {
    const n = t.name.toLowerCase();
    let i = -1;
    while ((i = lower.indexOf(n, i + 1)) !== -1) out.push({ idx: i, id: t.id });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

// abbreviations, but only as standalone tokens so "Tenacity" never reads as "T"
function letterMentions(line) {
  const out = [];
  const re = /[A-Za-z]{1,3}/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const before = line[m.index - 1] || ' ';
    const after = line[m.index + m[0].length] || ' ';
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue;
    const id = LETTER_MAP[m[0].toLowerCase()];
    if (id) out.push({ idx: m.index, id });
  }
  return out;
}

function parseLine(line) {
  const raw = line.trim();
  if (!raw) return null;

  let mentions = nameMentions(raw);
  if (mentions.length < 4) {
    const letters = letterMentions(raw);
    if (letters.length > mentions.length) mentions = letters;
  }
  if (!mentions.length) return null;

  const labels = [];
  LABEL_RE.lastIndex = 0;
  let lm;
  while ((lm = LABEL_RE.exec(raw)) !== null) labels.push({ idx: lm.index, bucket: labelBucket(lm[0]) });

  const firstMarker = Math.min(
    mentions[0].idx,
    labels.length ? labels[0].idx : Number.MAX_SAFE_INTEGER,
  );
  const name = raw.slice(0, firstMarker).replace(/[\s,;:|\t—–-]+$/, '').replace(/^[\s,;:|\t]+/, '').trim();

  // a header row mentions the labels but no person
  if (!name && labels.length) return null;

  const buckets = { g: [], c: [], f: [] };
  if (labels.length) {
    for (const mn of mentions) {
      let b = null;
      for (const l of labels) if (l.idx < mn.idx) b = l.bucket;
      if (b) buckets[b].push(mn.id);
    }
  } else {
    // positional: genius, genius, competency, competency, frustration, frustration
    const ids = mentions.map((x) => x.id);
    if (ids.length >= 6) { buckets.g = ids.slice(0, 2); buckets.c = ids.slice(2, 4); buckets.f = ids.slice(4, 6); }
    else if (ids.length === 4) { buckets.g = ids.slice(0, 2); buckets.f = ids.slice(2, 4); }
    else { buckets.g = ids.slice(0, 2); }
  }

  for (const k of ['g', 'c', 'f']) buckets[k] = [...new Set(buckets[k])];

  // fill in the third set when two are known — the report always implies it
  const known = ['g', 'c', 'f'].filter((k) => buckets[k].length === 2);
  if (known.length === 2) {
    const missing = ['g', 'c', 'f'].find((k) => !known.includes(k));
    const used = new Set([...buckets.g, ...buckets.c, ...buckets.f]);
    buckets[missing] = TYPES.filter((t) => !used.has(t.id)).map((t) => t.id);
  }

  const levels = TYPES.map((t) => (
    buckets.g.includes(t.id) ? 'g' : buckets.f.includes(t.id) ? 'f' : buckets.c.includes(t.id) ? 'c' : '?'
  )).join('');

  const problem = !name
    ? 'no name found on this line'
    : levels.includes('?') || !validLevels(levels)
      ? `needs two of each — read ${buckets.g.length} genius, ${buckets.c.length} competency, ${buckets.f.length} frustration`
      : null;

  return { name: name || raw.slice(0, 24), levels, buckets, problem, raw };
}

const parseBulk = (text) => text.split(/\r?\n/).map(parseLine).filter(Boolean);

let bulkRows = [];

function renderBulkPreview() {
  const host = document.getElementById('bulkPreview');
  host.replaceChildren();
  if (!bulkRows.length) return;

  const ok = bulkRows.filter((r) => !r.problem);
  const bad = bulkRows.filter((r) => r.problem);

  host.append(el('h3', { class: 'section-title', style: 'margin:0 0 4px', text: `Read ${bulkRows.length} line${bulkRows.length === 1 ? '' : 's'}` }));

  for (const r of bulkRows) {
    const cb = el('input', { type: 'checkbox', ...(r.problem ? {} : { checked: 'checked' }) });
    cb.disabled = !!r.problem;
    r._cb = cb;
    const summary = r.problem
      ? r.problem
      : `${TYPES.filter((t) => r.buckets.g.includes(t.id)).map((t) => t.name).join(' + ')}`
        + ` · drained by ${TYPES.filter((t) => r.buckets.f.includes(t.id)).map((t) => t.name).join(', ')}`;
    host.append(el('div', { class: 'imp-row' + (r.problem ? ' bad' : '') }, [
      cb,
      el('div', {}, [el('div', { class: 'ir-n', text: r.name }), el('div', { class: 'ir-s', text: summary })]),
      el('span', { class: `chip ${r.problem ? 'critical' : 'good'}` }, [el('span', { class: 'dot' }), r.problem ? 'Check' : 'Ready']),
    ]));
  }

  if (bad.length) {
    host.append(el('p', { class: 'hint', text: 'Lines it could not read are left out. Fix them in the box and read again, or add those people by hand below.' }));
  }

  host.append(el('div', { class: 'row', style: 'margin-top:14px' }, [
    el('button', {
      class: 'btn', type: 'button', text: `Add ${ok.length} to the team`,
      ...(ok.length ? {} : { disabled: 'disabled' }),
      onclick: () => commitBulk(false),
    }),
    el('button', {
      class: 'btn ghost', type: 'button', text: 'Replace this team',
      ...(ok.length ? {} : { disabled: 'disabled' }),
      onclick: () => commitBulk(true),
    }),
  ]));
}

function commitBulk(replace) {
  const picked = bulkRows.filter((r) => !r.problem && r._cb?.checked);
  if (!picked.length) return;

  const raw = (document.getElementById('bulkTeam').value || '').trim();
  const label = raw || `Team ${state.teams.length + 1}`;
  let team = state.teams.find((t) => t.name.toLowerCase() === label.toLowerCase());
  if (!team) {
    team = { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || uid('t'), name: label };
    if (state.teams.some((t) => t.id === team.id)) team.id = uid('t');
    state.teams.push(team);
  }

  const people = picked.map((r) => ({ id: uid(), name: r.name, levels: r.levels, team: team.id }));

  if (replace) {
    // replace only this team, never the others
    const goneIds = peopleOf(team.id).map((p) => p.id);
    state.people = state.people.filter((p) => p.team !== team.id);
    state.meetings.forEach((m) => { m.attendees = m.attendees.filter((id) => !goneIds.includes(id)); });
    if (goneIds.includes(state.viewerId)) state.viewerId = null;
  }
  state.people.push(...people);
  if (!byId(state.viewerId)) state.viewerId = state.people[0]?.id || null;
  if (!byId(state.leaderId)) state.leaderId = state.viewerId;

  state.teamFilter = team.id;
  bulkRows = [];
  document.getElementById('bulkText').value = '';
  save(); renderAll();
  toast(`${people.length} into ${team.name}${replace ? ' (replaced)' : ''}`);
}

/* ============================================================
   Shared
   ============================================================ */

function tableView(headers, rows) {
  return el('details', { class: 'tableview' }, [
    el('summary', { text: 'Table view' }),
    el('div', { class: 'tv-scroll' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', { text: String(c) }))))),
      ]),
    ]),
  ]);
}

let toastTimer = null;
function toast(msg) {
  const n = document.getElementById('toast');
  n.textContent = msg;
  n.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('on'), 2200);
}

const TABS = ['meeting', 'load', 'debrief', 'team', 'me'];
function showTab(which) {
  for (const k of TABS) {
    document.getElementById('tab-' + k).setAttribute('aria-selected', String(k === which));
    document.getElementById('panel-' + k).hidden = k !== which;
  }
  if (which === 'load') renderLoad();
  if (which === 'debrief') renderDebrief();
}

// Who am I looking at? This has to be unmissable — the whole panel below it
// means something different depending on the answer.
function viewerBar(note) {
  const v = viewer();
  const sel = el('select', { 'aria-label': 'Whose view to show' });
  for (const p of state.people) {
    sel.append(el('option', { value: p.id, ...(p.id === state.viewerId ? { selected: 'selected' } : {}) },
      [p.name + (p.id === state.leaderId ? ' — runs the team' : '')]));
  }
  if (!state.people.length) sel.append(el('option', { value: '' }, ['—']));
  sel.addEventListener('change', (e) => {
    state.viewerId = e.target.value;
    save(); renderLoad(); renderDebrief();
  });

  return el('div', { class: 'whobar' }, [
    el('div', { class: 'avatar', text: (v?.name || '?').trim().charAt(0).toUpperCase() }),
    el('div', { class: 'wb-t' }, [
      el('div', { class: 'wb-l', text: 'Viewing as' }),
      el('div', { class: 'wb-n' }, [
        v ? v.name : '—',
        v ? el('span', { class: 'teambadge', text: teamName(v) }) : null,
        isLeader() ? el('span', { class: 'wb-role', text: 'runs the team' }) : null,
      ]),
      note ? el('div', { class: 'wb-note', text: note }) : null,
    ]),
    el('div', { class: 'wb-sel' }, [el('span', { class: 'wb-swap', text: 'Switch' }), sel]),
  ]);
}

function renderAll() {
  renderTeamSwitcher();
  renderAddTeamSelect();
  renderMeeting();
  renderRoster();
  renderTeamViz();
  renderMe();
  renderLoad();
  renderDebrief();
}

/* ============================================================
   Example data — a real week, not a single meeting
   ============================================================ */

function newMeeting(patch = {}) {
  return {
    id: uid('m'), title: '', outcome: '', required: [], attendees: [], mode: 'intent', archetype: null,
    date: isoDate(new Date()), minutes: 60, touched: false, debriefs: {}, ...patch,
  };
}

let SEED = null;

function loadExample(quiet = false) {
  if (!SEED) return;

  state.teams = SEED.teams.map((t) => ({ id: t.id, name: t.name }));
  state.people = [];
  for (const t of SEED.teams) {
    for (const per of t.people) {
      state.people.push({ id: uid(), name: per.n, levels: per.l, team: t.id });
    }
  }
  state.teamFilter = state.teams[0]?.id || 'all';

  const pid = (team, name) => state.people.find((x) => x.team === team && x.name === name)?.id;
  const me = pid('ssg', 'P.L.');
  state.viewerId = me || state.people[0]?.id || null;
  state.leaderId = state.viewerId;

  const [mon, tue, wed, thu, fri] = weekDates();
  const ssg = (...names) => names.map((n) => pid('ssg', n)).filter(Boolean);

  state.meetings = [
    newMeeting({
      title: 'Weekly staff sync', date: mon, minutes: 60, touched: true, archetype: 'rally',
      outcome: 'Everyone leaves knowing the week\'s priorities and who owns what.',
      required: ['galvanizing', 'enablement', 'tenacity'],
      attendees: state.people.filter((x) => x.team === 'ssg').map((x) => x.id),
    }),
    newMeeting({
      title: 'Concept down-select', date: mon, minutes: 90, touched: true,
      outcome: 'Narrow six concepts to three and write down why.',
      required: ['discernment', 'invention'],
      attendees: ssg('P.L.', 'K.M.', 'M.L.', 'B.M.'),
    }),
    newMeeting({
      title: 'Daily standup', date: tue, minutes: 15, touched: true, archetype: 'task',
      outcome: 'Surface blockers before they cost a day.',
      required: ['tenacity', 'discernment'],
      attendees: ssg('N.P.', 'E.M.', 'A.H.'),
    }),
    newMeeting({
      title: '2040 portfolio review', date: tue, minutes: 90, touched: false,
      outcome: 'Decide which two concepts go forward, and get the chief engineer to commit resourcing.',
      required: ['invention', 'discernment', 'galvanizing'],
      attendees: ssg('P.L.', 'K.M.', 'M.L.'),
    }),
    newMeeting({
      title: 'Program sync — resourcing', date: wed, minutes: 60, touched: true,
      outcome: 'Unblock the three teams waiting on staffing.',
      required: ['enablement', 'tenacity'],
      attendees: ssg('P.L.', 'A.H.', 'B.B.'),
    }),
    newMeeting({
      title: 'Stakeholder alignment', date: wed, minutes: 90, touched: true,
      outcome: 'Get the two directorates behind the plan and supporting it out loud.',
      required: ['galvanizing', 'enablement'],
      attendees: ssg('P.L.', 'A.H.', 'R.G.'),
    }),
    newMeeting({
      title: 'Supplier escalation', date: wed, minutes: 60, touched: true,
      outcome: 'Commit the supplier to a recovery schedule.',
      required: ['galvanizing', 'tenacity'],
      attendees: ssg('P.L.', 'T.S.'),
    }),
    newMeeting({
      title: 'Cross-team integration review', date: thu, minutes: 120, touched: true,
      outcome: 'Agree the integration sequence across SSG, ECS and GRS and name who finishes each piece.',
      required: ['discernment', 'tenacity', 'enablement'],
      attendees: [
        ...ssg('P.L.', 'M.L.'),
        pid('ecs', 'C.F.'), pid('ecs', 'P.C.'),
        pid('grs', 'G.M.'), pid('grs', 'P.Y.'),
      ].filter(Boolean),
    }),
    newMeeting({
      title: 'Closeout review', date: fri, minutes: 45, touched: true, archetype: 'task',
      outcome: 'Finish the milestone package and ship it.',
      required: ['tenacity', 'discernment'],
      attendees: [...ssg('N.P.', 'E.M.'), pid('ecs', 'C.F.')].filter(Boolean),
    }),
  ];

  // A run of debriefed history, so the forecast has something to learn from.
  // Meetings that were short a type mostly missed; the covered ones mostly landed.
  const debrief = (title, entries) => {
    const mm = state.meetings.find((x) => x.title === title);
    if (!mm) return;
    mm.debriefs = {};
    for (const [name, d] of entries) {
      const id = pid('ssg', name) || pid('ecs', name) || pid('grs', name);
      if (id && mm.attendees.includes(id)) mm.debriefs[id] = { obs: {}, ...d };
    }
  };

  debrief('Stakeholder alignment', [
    ['P.L.', { felt: 'draining', outcome: 'no', note: 'I should not have run this one.', obs: { [pid('ssg', 'A.H.')]: ['carried', 'underused'] } }],
    ['A.H.', { felt: 'energizing', outcome: 'partly', note: 'Happy to take the front on these.', obs: { [me]: ['drained'] } }],
    ['R.G.', { felt: 'fine', outcome: 'no' }],
  ]);
  debrief('Weekly staff sync', [
    ['P.L.', { felt: 'draining', outcome: 'partly', note: 'Too many people for what it decides.' }],
    ['A.H.', { felt: 'fine', outcome: 'partly' }],
    ['N.P.', { felt: 'draining', outcome: 'no' }],
  ]);
  debrief('Concept down-select', [
    ['P.L.', { felt: 'energizing', outcome: 'yes', note: 'Right people, right length.' }],
    ['K.M.', { felt: 'energizing', outcome: 'yes' }],
    ['M.L.', { felt: 'fine', outcome: 'yes' }],
  ]);
  debrief('Daily standup', [
    ['N.P.', { felt: 'fine', outcome: 'yes' }],
    ['E.M.', { felt: 'fine', outcome: 'yes' }],
  ]);
  debrief('Supplier escalation', [
    ['P.L.', { felt: 'draining', outcome: 'no', note: 'Wrong person in the chair — me.' }],
    ['T.S.', { felt: 'fine', outcome: 'partly' }],
  ]);
  debrief('Program sync — resourcing', [
    ['P.L.', { felt: 'draining', outcome: 'partly' }],
    ['A.H.', { felt: 'energizing', outcome: 'yes' }],
    ['B.B.', { felt: 'fine', outcome: 'yes' }],
  ]);
  debrief('Closeout review', [
    ['N.P.', { felt: 'fine', outcome: 'partly' }],
    ['E.M.', { felt: 'fine', outcome: 'yes' }],
  ]);

  state.currentId = state.meetings.find((m) => m.title === '2040 portfolio review').id;

  save(); renderAll();
  if (!quiet) toast(`Loaded ${state.teams.length} teams, ${state.people.length} people`);
}

/* ============================================================
   Wiring
   ============================================================ */

function bindMeetingField(elmId, apply) {
  document.getElementById(elmId).addEventListener('input', (e) => {
    const m = current();
    if (!m) return;
    apply(m, e.target.value);
    save();
    renderMeetingBar();
    renderMeetingList();
    if (elmId === 'mOutcome') { renderTypePicker(); renderVerdict(); }
    if (elmId === 'mMinutes' || elmId === 'mDate') renderLoad();
  });
}

function wire() {
  for (const k of TABS) document.getElementById('tab-' + k).addEventListener('click', () => showTab(k));

  bindMeetingField('mTitle', (m, v) => { m.title = v; });
  bindMeetingField('mOutcome', (m, v) => { m.outcome = v; });
  bindMeetingField('mDate', (m, v) => { m.date = v; });
  document.getElementById('mMinutes').addEventListener('change', (e) => {
    const m = current(); if (!m) return;
    m.minutes = Number(e.target.value); save(); renderMeetingBar(); renderMeetingList(); renderLoad();
  });

  document.getElementById('newMeetingBtn2').addEventListener('click', () => startNewMeeting());

  document.getElementById('meName').addEventListener('input', (e) => { state.me.name = e.target.value; save(); renderMe(); });

  document.getElementById('meCopyBtn').addEventListener('click', async () => {
    const ok = await copyText(encodeProfile({ name: state.me.name.trim(), levels: state.me.levels }));
    toast(ok ? 'Code copied — send it to whoever runs the map' : 'Could not copy — select the code and copy it');
  });

  document.getElementById('meAddBtn').addEventListener('click', () => {
    const p = { id: uid(), name: state.me.name.trim(), levels: state.me.levels, team: addTeamId() };
    state.people.push(p);
    if (!state.viewerId) state.viewerId = p.id;
    save(); renderAll(); showTab('team'); toast('Added to the team');
  });

  document.getElementById('addCodeBtn').addEventListener('click', () => {
    const input = document.getElementById('pasteCode');
    const p = decodeProfile(input.value);
    if (!p) { toast('That code did not read — check it was copied whole'); return; }
    p.team = addTeamId();
    state.people.push(p);
    if (!state.viewerId) state.viewerId = p.id;
    input.value = '';
    save(); renderAll(); toast(`${p.name} added`);
  });

  document.getElementById('demoBtn').addEventListener('click', () => loadExample(false));
  document.getElementById('newTeamBtn').addEventListener('click', addTeam);

  document.getElementById('bulkParseBtn').addEventListener('click', () => {
    const text = document.getElementById('bulkText').value;
    bulkRows = parseBulk(text);
    renderBulkPreview();
    if (!bulkRows.length) toast('Nothing readable in there — try the formats button');
  });

  document.getElementById('bulkFmtBtn').addEventListener('click', () => {
    const box = document.getElementById('bulkFmt');
    box.hidden = !box.hidden;
    if (box.hidden) return;
    box.replaceChildren(
      el('p', { class: 'hint', style: 'margin:0 0 8px', text: 'All of these read cleanly. Labels can be Genius / Competency / Frustration, or WG / WC / WF. Give it any two of the three and it works out the third.' }),
      el('div', { class: 'fmt', text: [
        'Marisol Reyes — Genius: Wonder, Galvanizing; Frustration: Enablement, Tenacity',
        'Dev Osei | WG: Discernment, Tenacity | WC: Invention, Galvanizing | WF: Wonder, Enablement',
        'Anne Whitlock, Enablement, Tenacity, Galvanizing, Discernment, Wonder, Invention',
        'Ray Alvarez: W, I / G, D / E, T',
      ].join('\n') }),
      el('p', { class: 'hint', text: 'Third line is positional — two genius, two competency, two frustration, in that order. Header rows and blank lines are ignored.' }),
    );
  });

  document.getElementById('shareTeamBtn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#team=${encodeState(state.people.map((p) => [p.name, p.levels, teamName(p)]))}`;
    toast(await copyText(url) ? 'Team link copied' : 'Could not copy the link');
  });

  document.getElementById('manualBtn').addEventListener('click', () => {
    const wrap = document.getElementById('manualWrap');
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) renderManual();
  });
}

function renderManual() {
  const wrap = document.getElementById('manualWrap');
  wrap.replaceChildren();
  const draft = { name: '', levels: 'c'.repeat(TYPES.length) };
  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; paint(); });
  wrap.append(el('label', { class: 'field' }, [el('span', { text: 'Name' }), nameInput]));
  const rows = el('div');
  const tally = el('p', { class: 'tally', style: 'margin:10px 0 0' });
  const addBtn = el('button', { class: 'btn', type: 'button', text: 'Add', disabled: 'disabled' });
  wrap.append(rows, tally, el('div', { class: 'row', style: 'margin-top:12px' }, [addBtn]));

  function paint() {
    rows.replaceChildren();
    for (const [i, t] of TYPES.entries()) {
      const seg = el('div', { class: 'seg' });
      for (const lv of MODEL.levels) {
        seg.append(el('button', {
          type: 'button', 'data-lvl': lv.id, text: lv.short,
          'aria-pressed': String(draft.levels[i] === lv.id),
          onclick: () => { const a = [...draft.levels]; a[i] = lv.id; draft.levels = a.join(''); paint(); },
        }));
      }
      rows.append(el('div', { class: 'lvl-row' }, [el('div', {}, [el('div', { class: 'tname', text: t.name })]), seg]));
    }
    const got = { g: 0, c: 0, f: 0 };
    for (const ch of draft.levels) got[ch] += 1;
    const ok = validLevels(draft.levels) && draft.name.trim();
    tally.textContent = `G ${got.g}/2 · C ${got.c}/2 · F ${got.f}/2`;
    tally.className = 'tally' + (ok ? '' : ' bad');
    if (ok) addBtn.removeAttribute('disabled'); else addBtn.setAttribute('disabled', 'disabled');
  }

  addBtn.addEventListener('click', () => {
    if (!validLevels(draft.levels) || !draft.name.trim()) return;
    const p = { id: uid(), name: draft.name.trim(), levels: draft.levels, team: addTeamId() };
    state.people.push(p);
    if (!state.viewerId) state.viewerId = p.id;
    save(); renderAll(); toast(`${p.name} added`);
    draft.name = ''; draft.levels = 'c'.repeat(TYPES.length); nameInput.value = ''; paint();
  });
  paint();
}

function importFromHash() {
  const m = location.hash.match(/team=([A-Za-z0-9\-_]+)/);
  if (!m) return;
  const raw = decodeState(m[1]);
  if (!Array.isArray(raw)) return;
  const rows = raw.filter((r) => Array.isArray(r) && validLevels(r[1]));
  const teams = [...new Set(rows.map((r) => r[2] || 'Team 1'))]
    .map((n) => ({ id: String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-') || uid('t'), name: String(n) }));
  const people = rows.map(([name, levels, tn]) => ({
    id: uid(), name: String(name).slice(0, 40), levels,
    team: teams.find((t) => t.name === (tn || 'Team 1'))?.id || teams[0]?.id,
  }));
  if (people.length) {
    state.teams = teams;
    state.people = people;
    state.teamFilter = teams[0]?.id || 'all';
    state.viewerId = people[0].id;
    state.meetings = [];
    save();
    toast(`Loaded ${people.length} people from the link`);
  }
  history.replaceState(null, '', location.pathname);
}

/* ============================================================
   Boot
   ============================================================ */

Promise.all([
  fetch('./model.json').then((r) => r.json()),
  fetch('./seed.json').then((r) => r.json()).catch(() => ({ teams: [] })),
])
  .then(([m, seed]) => {
    SEED = seed;
    MODEL = m;
    TYPES = m.types;
    TYPES.forEach((t, i) => { TIDX[t.id] = i; });
    state.me.levels = 'c'.repeat(TYPES.length);

    const hadSaved = load();
    importFromHash();
    wire();

    window.__startNewMeeting = startNewMeeting;

    // Seed the shipped teams for anyone opening this fresh — app or demo.
    // Never stomp on a roster somebody has already imported or edited.
    window.__resetDemo = () => { loadExample(true); showTab('meeting'); };
    if (!hadSaved || !state.people.length) {
      loadExample(true);
    } else {
      renderAll();
    }

    document.getElementById('modelNote').textContent = m.note;
  })
  .catch((e) => {
    document.body.innerHTML = `<div class="wrap"><div class="card">Could not load the model file. ${e}</div></div>`;
  });
