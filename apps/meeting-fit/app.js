import { initTheme, registerSW, el, store, encodeState, decodeState, copyText } from '../../assets/shell.js';

initTheme();
registerSW('../../sw.js');

/* ============================================================
   State
   ============================================================ */

const KEY = 'meetingFit.v1';

let MODEL = null;
let TYPES = [];
let TIDX = {};                       // type id -> column index in the levels string

const state = {
  team: [],                          // { id, name, levels: 'gcfcgf' }
  meeting: { title: '', outcome: '', required: [], attendees: [] },
  me: { name: '', levels: 'cccccc' },
  touchedTypes: false,               // has the director overridden the suggestion?
};

function save() {
  store.set(KEY, JSON.stringify({ team: state.team, meeting: state.meeting, me: state.me }));
}

function load() {
  const raw = store.get(KEY);
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    if (Array.isArray(d.team)) state.team = d.team;
    if (d.meeting) Object.assign(state.meeting, d.meeting);
    if (d.me) Object.assign(state.me, d.me);
  } catch { /* corrupt payload — start clean */ }
}

const uid = () => 'p' + Math.random().toString(36).slice(2, 9);

/* ============================================================
   Profile codes  —  "Name~gcfcgf"
   ============================================================ */

function encodeProfile(p) { return encodeState([p.name, p.levels]); }

function decodeProfile(code) {
  const raw = decodeState(code.trim());
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [name, levels] = raw;
  if (typeof name !== 'string' || typeof levels !== 'string') return null;
  if (!validLevels(levels)) return null;
  return { id: uid(), name: name.slice(0, 40) || 'Unnamed', levels };
}

function validLevels(lv) {
  if (typeof lv !== 'string' || lv.length !== TYPES.length) return false;
  if (!/^[gcf]+$/.test(lv)) return false;
  const need = MODEL.perPerson;
  for (const k of ['g', 'c', 'f']) {
    if ([...lv].filter((ch) => ch === k).length !== need[k]) return false;
  }
  return true;
}

const levelsOf = (p, tid) => p.levels[TIDX[tid]];
const geniusesOf = (p) => TYPES.filter((t) => levelsOf(p, t.id) === 'g');

/* ============================================================
   Outcome text -> suggested types
   ============================================================ */

const CUES = {
  wonder: ['explore', 'why', 'should we', 'opportunity', 'understand', 'landscape', 'question', 'what if', 'reframe', 'diagnose', 'is there'],
  invention: ['brainstorm', 'idea', 'design', 'come up with', 'generate', 'concept', 'options', 'propose', 'draft', 'invent', 'solution', 'approach'],
  discernment: ['decide', 'decision', 'choose', 'select', 'evaluate', 'prioriti', 'go/no-go', 'go / no-go', 'assess', 'review', 'vet', 'narrow', 'which', 'pick', 'down-select', 'downselect', 'judge', 'recommend'],
  galvanizing: ['align', 'buy-in', 'buy in', 'kickoff', 'kick off', 'rally', 'commit', 'socialize', 'socialise', 'sell', 'launch', 'momentum', 'sponsor', 'convince', 'persuade', 'get people', 'endorse', 'sign off', 'sign-off', 'approval'],
  enablement: ['support', 'help', 'unblock', 'resourc', 'onboard', 'assist', 'coordinat', 'enable', 'staff', 'hand off', 'handoff', 'train', 'respond'],
  tenacity: ['finish', 'close out', 'closeout', 'ship', 'deliver', 'deadline', 'complete', 'status', 'track', 'milestone', 'wrap', 'follow through', 'follow-through', 'due', 'schedule', 'execute'],
};

function suggestTypes(text) {
  const s = (text || '').toLowerCase();
  if (!s.trim()) return [];
  const hits = [];
  for (const t of TYPES) {
    const cues = CUES[t.id] || [];
    const n = cues.filter((c) => s.includes(c)).length;
    if (n > 0) hits.push({ id: t.id, n });
  }
  hits.sort((a, b) => b.n - a.n);
  return hits.slice(0, 3).map((h) => h.id);
}

/* ============================================================
   The analysis
   ============================================================ */

const STATUS_LABEL = {
  good: 'Covered',
  warning: 'Thin',
  serious: 'Competency only',
  critical: 'Gap',
};

function analyze() {
  const inRoom = state.team.filter((p) => state.meeting.attendees.includes(p.id));
  const bench = state.team.filter((p) => !state.meeting.attendees.includes(p.id));
  const required = state.meeting.required
    .map((id) => TYPES.find((t) => t.id === id))
    .filter(Boolean);

  const coverage = required.map((type) => {
    const g = inRoom.filter((p) => levelsOf(p, type.id) === 'g');
    const c = inRoom.filter((p) => levelsOf(p, type.id) === 'c');
    const f = inRoom.filter((p) => levelsOf(p, type.id) === 'f');
    const rescue = bench.filter((p) => levelsOf(p, type.id) === 'g');

    let status;
    if (g.length === 0 && c.length === 0) status = 'critical';
    else if (g.length === 0) status = 'serious';
    else if (g.length === 1) status = 'warning';
    else status = 'good';

    return { type, g, c, f, rescue, status };
  });

  const gaps = coverage.filter((c) => c.status === 'critical' || c.status === 'serious');
  const thin = coverage.filter((c) => c.status === 'warning');

  // people in the room whose geniuses are not used by this meeting at all
  const idle = inRoom.filter((p) => !required.some((t) => levelsOf(p, t.id) === 'g'));
  // people for whom this meeting is mostly draining
  const drained = inRoom.filter((p) => required.filter((t) => levelsOf(p, t.id) === 'f').length >= 2);

  return { inRoom, bench, required, coverage, gaps, thin, idle, drained };
}

function verdictSentence(a) {
  if (!a.required.length) return 'Pick what the meeting needs and the read will appear here.';
  if (!a.inRoom.length) return 'Nobody is in the room yet. Add attendees to see whether the meeting matches them.';

  const names = (arr) => arr.map((p) => p.name).join(', ');

  if (a.gaps.length) {
    const list = a.gaps.map((c) => c.type.name);
    const label = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.slice(-1)}`;
    const worst = a.gaps.find((c) => c.status === 'critical') || a.gaps[0];
    let s = `This meeting needs ${label}, and the room is not built for it. `;
    if (worst.status === 'critical') {
      s += `Nobody here is energised by ${worst.type.name}`;
      if (worst.f.length) s += `, and ${worst.f.length === 1 ? names(worst.f) + ' is' : names(worst.f) + ' are'} drained by it`;
      s += '. ';
    } else {
      s += `${worst.type.name} is carried only as a competency — it will get done in the room and cost someone afterwards. `;
    }
    return s + failureMode(worst.type);
  }

  if (a.thin.length) {
    const t = a.thin[0];
    return `The room covers what the meeting needs, but ${t.type.name} rests on one person — ${names(t.g)}. If they are quiet, that part of the meeting does not happen.`;
  }

  return 'The room matches the meeting. Every type this meeting needs has more than one person here who gains energy from it.';
}

function failureMode(type) {
  const phase = MODEL.phases.find((p) => p.id === type.phase);
  const ho = MODEL.handoffs.find((h) => h.to === type.phase);
  if (ho) return `Expect the classic ${phase.name.toLowerCase()} failure: ${ho.symptom.toLowerCase()}`;
  return `Expect the ${phase.name.toLowerCase()} half of this meeting to stall.`;
}

/* ============================================================
   Rendering — meeting panel
   ============================================================ */

function renderTypePicker() {
  const host = document.getElementById('typePicker');
  host.replaceChildren();

  const suggested = state.touchedTypes ? [] : suggestTypes(state.meeting.outcome);
  if (!state.touchedTypes && suggested.length) state.meeting.required = suggested.slice();

  for (const t of TYPES) {
    const on = state.meeting.required.includes(t.id);
    const isSug = suggested.includes(t.id);
    host.append(el('button', {
      class: 'typechip',
      type: 'button',
      'aria-pressed': String(on),
      title: t.desc,
      onclick: () => {
        state.touchedTypes = true;
        const i = state.meeting.required.indexOf(t.id);
        if (i >= 0) state.meeting.required.splice(i, 1);
        else state.meeting.required.push(t.id);
        save(); renderMeeting();
      },
    }, [
      el('div', { class: 'tc-name' }, [t.name, isSug ? el('span', { class: 'tc-sug', text: 'suggested' }) : null]),
      el('div', { class: 'tc-phase', text: MODEL.phases.find((p) => p.id === t.phase).name }),
    ]));
  }

  const note = document.getElementById('sugNote');
  if (state.touchedTypes) {
    note.textContent = 'You have set these by hand. Clearing the outcome text will not change them.';
  } else if (suggested.length) {
    note.textContent = 'Suggested from your outcome text. Keyword matching, not judgement — override anything that looks wrong.';
  } else {
    note.textContent = 'Write an intended outcome above and this will pre-select, or just pick them yourself.';
  }
}

function renderAttendeePicker() {
  const host = document.getElementById('attendeePicker');
  host.replaceChildren();

  if (!state.team.length) {
    host.append(el('div', { class: 'empty' },
      'No team yet. Add people on the Team tab — or load the example team to see how this reads.'));
    return;
  }

  for (const p of state.team) {
    const on = state.meeting.attendees.includes(p.id);
    const cb = el('input', { type: 'checkbox', ...(on ? { checked: 'checked' } : {}) });
    cb.addEventListener('change', () => {
      const i = state.meeting.attendees.indexOf(p.id);
      if (cb.checked && i < 0) state.meeting.attendees.push(p.id);
      if (!cb.checked && i >= 0) state.meeting.attendees.splice(i, 1);
      save(); renderMeeting();
    });
    host.append(el('label', { class: 'checkline' }, [
      cb,
      el('div', {}, [
        el('div', { class: 'cl-name', text: p.name }),
        el('div', { class: 'cl-sub', text: geniusesOf(p).map((t) => t.name).join(' · ') }),
      ]),
    ]));
  }
}

function renderVerdict() {
  const host = document.getElementById('verdictCol');
  host.replaceChildren();

  const a = analyze();
  const ready = a.required.length && a.inRoom.length;

  /* --- hero: the one number this view leads with --- */
  const figure = ready ? a.gaps.length : '—';
  const heroCard = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'The read' }),
    el('div', { class: 'hero' }, [
      el('div', {
        class: 'figure ' + (!ready ? '' : a.gaps.length ? 'bad' : 'good'),
        text: String(figure),
      }),
      el('div', {
        class: 'cap',
        text: !ready
          ? 'Waiting on a meeting definition and at least one attendee.'
          : a.gaps.length === 1
            ? 'thing this meeting needs that the room cannot supply'
            : 'things this meeting needs that the room cannot supply',
      }),
    ]),
    el('p', { class: 'verdict-line', text: verdictSentence(a) }),
  ]);

  if (ready && a.gaps.length) {
    const fixes = [];
    for (const c of a.gaps) {
      if (c.rescue.length) {
        fixes.push(el('div', {}, [
          'Bring in ', el('strong', { text: c.rescue.map((p) => p.name).join(' or ') }),
          ` — ${c.rescue.length === 1 ? 'they carry' : 'they carry'} ${c.type.name}.`,
        ]));
      } else {
        fixes.push(el('div', {}, [
          'Nobody on this team carries ', el('strong', { text: c.type.name }),
          '. The invite list cannot fix this one — either the meeting is the wrong shape, or that work needs someone from outside it.',
        ]));
      }
    }
    heroCard.append(el('div', { class: 'fix' }, fixes));
  }
  host.append(heroCard);

  if (!ready) return;

  /* --- coverage detail --- */
  const cov = el('div', { class: 'card' }, [el('h2', { class: 'section-title', text: 'What the meeting needs, against who is here' })]);
  for (const c of a.coverage) {
    const who = [];
    if (c.g.length) who.push(`energised: ${c.g.map((p) => p.name).join(', ')}`);
    if (c.c.length) who.push(`capable: ${c.c.map((p) => p.name).join(', ')}`);
    if (c.f.length) who.push(`drained: ${c.f.map((p) => p.name).join(', ')}`);
    cov.append(el('div', { class: 'cov-row' }, [
      el('div', {}, [
        el('div', { class: 'cr-name', text: c.type.name }),
        el('div', { class: 'cr-who', text: who.length ? who.join(' · ') : 'nobody in the room registers on this' }),
      ]),
      el('span', { class: `chip ${c.status}` }, [el('span', { class: 'dot' }), STATUS_LABEL[c.status]]),
    ]));
  }
  cov.append(tableView(
    ['Type', 'Energised', 'Capable', 'Drained', 'Verdict'],
    a.coverage.map((c) => [c.type.name, c.g.length, c.c.length, c.f.length, STATUS_LABEL[c.status]]),
  ));
  host.append(cov);

  /* --- who is in the room for no reason --- */
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

  /* --- agenda shape --- */
  host.append(renderAgenda(a));
}

function renderAgenda(a) {
  const card = el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'Suggested shape' }),
  ]);
  const list = el('ol', { class: 'agenda' });

  let n = 0;
  for (const phase of MODEL.phases) {
    const types = a.required.filter((t) => t.phase === phase.id);
    if (!types.length) continue;
    n += 1;

    // a lead is named per type, not per phase — otherwise a covered type
    // silently vouches for an uncovered one sitting next to it
    const byType = types.map((t) => ({ t, leads: a.inRoom.filter((p) => levelsOf(p, t.id) === 'g') }));
    const led = byType.filter((x) => x.leads.length);
    const unled = byType.filter((x) => !x.leads.length);

    const body = [];
    body.push(`${phase.desc}. `);
    if (led.length) {
      body.push(led.map((x) => `${x.t.name} belongs to ${x.leads.map((p) => p.name).join(' or ')}`).join('; ') + '. ');
    }
    if (unled.length) {
      body.push(`Nobody in the room leads ${unled.map((x) => x.t.name).join(' or ')} — give it a named owner and a hard time box, or the meeting drifts past it.`);
    }

    list.append(el('li', { class: 'ag-item' }, [
      el('div', { class: 'num', text: String(n) }),
      el('div', {}, [
        el('div', { class: 'ag-h' }, [
          phase.name,
          el('span', { style: 'font-weight:450;color:var(--text-muted);font-size:12.5px' }, types.map((t) => t.name).join(' + ')),
          unled.length
            ? el('span', { class: 'chip critical' }, [
                el('span', { class: 'dot' }),
                unled.length === byType.length ? 'No lead' : `No lead for ${unled.map((x) => x.t.name).join(', ')}`,
              ])
            : null,
        ]),
        el('div', { class: 'ag-b', text: body.join('') }),
      ]),
    ]));
  }

  if (!n) {
    card.append(el('div', { class: 'empty', text: 'Pick at least one type and the shape will build itself.' }));
  } else {
    card.append(list);
    const tail = a.required.some((t) => t.phase === 'implementation')
      ? 'Close by naming who owns the finish, out loud, before anyone leaves.'
      : 'This meeting has no implementation type in it. That is fine — but it means nothing here is going to get finished, so do not let it end feeling like something did.';
    card.append(el('p', { style: 'font-size:13px;color:var(--text-muted);margin:14px 0 0;line-height:1.6', text: tail }));
  }
  return card;
}

function renderMeeting() {
  document.getElementById('mTitle').value = state.meeting.title;
  document.getElementById('mOutcome').value = state.meeting.outcome;
  renderTypePicker();
  renderAttendeePicker();
  renderVerdict();
}

/* ============================================================
   Rendering — team panel
   ============================================================ */

function renderRoster() {
  const host = document.getElementById('roster');
  host.replaceChildren();
  document.getElementById('teamCount').textContent = String(state.team.length);
  document.getElementById('teamCount2').textContent = state.team.length ? `· ${state.team.length}` : '';

  if (!state.team.length) {
    host.append(el('div', { class: 'empty' }, 'Nobody yet. Paste a code, enter someone manually, or load the example team.'));
    return;
  }

  for (const p of state.team) {
    host.append(el('div', { class: 'person' }, [
      el('div', {}, [
        el('div', { class: 'pname', text: p.name }),
        el('div', { class: 'pgen', text: geniusesOf(p).map((t) => t.name).join(' · ') }),
      ]),
      el('button', {
        class: 'pdel', type: 'button', text: 'Remove',
        onclick: () => {
          state.team = state.team.filter((x) => x.id !== p.id);
          state.meeting.attendees = state.meeting.attendees.filter((id) => id !== p.id);
          save(); renderRoster(); renderTeamViz(); renderMeeting();
        },
      }),
    ]));
  }
}

function renderTeamViz() {
  const host = document.getElementById('teamViz');
  host.replaceChildren();

  if (!state.team.length) {
    host.append(el('div', { class: 'card' }, [el('div', { class: 'empty' }, 'The team picture appears once someone is on it.')]));
    return;
  }

  /* --- bar chart: how many people are energised by each type --- */
  const counts = TYPES.map((t) => ({ t, n: state.team.filter((p) => levelsOf(p, t.id) === 'g').length }));
  const max = Math.max(1, ...counts.map((c) => c.n));

  const bars = el('div', { class: 'bars' });
  for (const c of counts) {
    bars.append(el('div', { class: 'bar-row', title: `${c.n} of ${state.team.length} energised by ${c.t.name}` }, [
      el('div', { class: 'bl', text: c.t.name }),
      el('div', { class: 'bar-track' }, [
        el('div', {
          class: 'bar-fill' + (c.n === 0 ? ' zero' : ''),
          style: `width:${c.n === 0 ? 3 : Math.round((c.n / max) * 100)}%`,
        }),
      ]),
      el('div', { class: 'bv', text: String(c.n) }),
    ]));
  }

  const zero = counts.filter((c) => c.n === 0);
  host.append(el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'Where this team gains energy' }),
    el('p', { style: 'font-size:13px;color:var(--text-secondary);margin:0 0 16px;line-height:1.55', text: `People on the team energised by each type, out of ${state.team.length}.` }),
    bars,
    zero.length
      ? el('div', { class: 'fix' }, [
          'Nobody here is energised by ',
          el('strong', { text: zero.map((c) => c.t.name).join(' or ') }),
          '. Any meeting that needs it will stall at that point, every time, no matter who is in the room.',
        ])
      : null,
    tableView(['Type', 'Phase', 'Energised', 'Capable', 'Drained'], TYPES.map((t) => [
      t.name,
      MODEL.phases.find((p) => p.id === t.phase).name,
      state.team.filter((p) => levelsOf(p, t.id) === 'g').length,
      state.team.filter((p) => levelsOf(p, t.id) === 'c').length,
      state.team.filter((p) => levelsOf(p, t.id) === 'f').length,
    ])),
  ]));

  /* --- matrix --- */
  const mx = el('div', { class: 'matrix', style: `grid-template-columns: minmax(96px, 1.4fr) repeat(${TYPES.length}, 1fr)` });
  mx.append(el('div', { class: 'mx-head' }));
  for (const t of TYPES) mx.append(el('div', { class: 'mx-head', text: t.short, title: t.name }));
  for (const p of state.team) {
    mx.append(el('div', { class: 'mx-name', text: p.name }));
    for (const t of TYPES) {
      const lv = levelsOf(p, t.id);
      const lname = MODEL.levels.find((l) => l.id === lv).name;
      mx.append(el('div', {
        class: 'mx-cell', 'data-lvl': lv,
        text: lv.toUpperCase(),
        title: `${p.name} — ${t.name}: ${lname}`,
      }));
    }
  }

  host.append(el('div', { class: 'card' }, [
    el('h2', { class: 'section-title', text: 'The team, cell by cell' }),
    el('div', { class: 'matrix-scroll' }, [mx]),
    el('div', { class: 'legend' }, MODEL.levels.map((l) =>
      el('div', { class: 'lg' }, [el('span', { class: `sw ${l.id}` }), `${l.short} — ${l.name}`]))),
  ]));
}

/* ============================================================
   Rendering — my profile
   ============================================================ */

function renderMe() {
  const host = document.getElementById('meLevels');
  host.replaceChildren();
  document.getElementById('meName').value = state.me.name;

  for (const [i, t] of TYPES.entries()) {
    const seg = el('div', { class: 'seg' });
    for (const lv of MODEL.levels) {
      seg.append(el('button', {
        type: 'button',
        'data-lvl': lv.id,
        'aria-pressed': String(state.me.levels[i] === lv.id),
        title: `${t.name}: ${lv.desc}`,
        text: lv.short,
        onclick: () => {
          const arr = [...state.me.levels];
          arr[i] = lv.id;
          state.me.levels = arr.join('');
          save(); renderMe();
        },
      }));
    }
    host.append(el('div', { class: 'lvl-row' }, [
      el('div', {}, [
        el('div', { class: 'tname', text: t.name }),
        el('div', { class: 'tphase', text: t.desc }),
      ]),
      seg,
    ]));
  }

  const need = MODEL.perPerson;
  const got = { g: 0, c: 0, f: 0 };
  for (const ch of state.me.levels) got[ch] += 1;
  const ok = validLevels(state.me.levels) && state.me.name.trim().length > 0;

  const tally = document.getElementById('meTally');
  tally.textContent = `Genius ${got.g}/${need.g} · Competency ${got.c}/${need.c} · Frustration ${got.f}/${need.f}`
    + (state.me.name.trim() ? '' : ' — add your name');
  tally.className = 'tally' + (ok ? '' : ' bad');

  document.getElementById('meCopyBtn').disabled = !ok;
  document.getElementById('meAddBtn').disabled = !ok;
  document.getElementById('meCode').textContent = ok
    ? encodeProfile({ name: state.me.name.trim(), levels: state.me.levels })
    : 'Set exactly two of each above, and add your name.';
}

/* ============================================================
   Shared bits
   ============================================================ */

function tableView(headers, rows) {
  const t = el('table', { class: 'data' }, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', { text: String(c) }))))),
  ]);
  return el('details', { class: 'tableview' }, [el('summary', { text: 'Table view' }), t]);
}

let toastTimer = null;
function toast(msg) {
  const n = document.getElementById('toast');
  n.textContent = msg;
  n.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('on'), 2200);
}

function showTab(which) {
  for (const k of ['meeting', 'team', 'me']) {
    document.getElementById('tab-' + k).setAttribute('aria-selected', String(k === which));
    document.getElementById('panel-' + k).hidden = k !== which;
  }
}

/* ============================================================
   Example team
   ============================================================ */

function loadExample(quiet = false) {
  // level order matches model.json: wonder, invention, discernment, galvanizing, enablement, tenacity
  const people = [
    ['You',     'cggffc'],   // Invention + Discernment;  drained by Galvanizing + Enablement
    ['Marisol', 'gccgff'],   // Wonder + Galvanizing
    ['Dev',     'fcgcfg'],   // Discernment + Tenacity
    ['Anne',    'ffccgg'],   // Enablement + Tenacity
    ['Ray',     'ggcfcf'],   // Wonder + Invention
    ['Priya',   'ffcgcg'],   // Galvanizing + Tenacity
  ];
  state.team = people
    .filter(([, lv]) => validLevels(lv))
    .map(([name, levels]) => ({ id: uid(), name, levels }));

  // an invite list that looks sensible and quietly misses one thing
  const pick = ['You', 'Dev', 'Anne'];
  state.meeting.attendees = state.team.filter((p) => pick.includes(p.name)).map((p) => p.id);

  if (quiet || (!state.meeting.title.trim() && !state.meeting.outcome.trim())) {
    state.meeting.title = '2040 portfolio review';
    state.meeting.outcome = 'Decide which two concepts go forward, and get the chief engineer to commit resourcing.';
    state.touchedTypes = false;
  }

  save(); renderRoster(); renderTeamViz(); renderMeeting();
  if (!quiet) toast(`Example loaded — ${state.team.length} people`);
}

/* ============================================================
   Wiring
   ============================================================ */

function wire() {
  for (const k of ['meeting', 'team', 'me']) {
    document.getElementById('tab-' + k).addEventListener('click', () => showTab(k));
  }

  document.getElementById('mTitle').addEventListener('input', (e) => {
    state.meeting.title = e.target.value; save();
  });

  document.getElementById('mOutcome').addEventListener('input', (e) => {
    state.meeting.outcome = e.target.value;
    save(); renderTypePicker(); renderVerdict();
  });

  document.getElementById('meName').addEventListener('input', (e) => {
    state.me.name = e.target.value; save(); renderMe();
  });

  document.getElementById('meCopyBtn').addEventListener('click', async () => {
    const ok = await copyText(encodeProfile({ name: state.me.name.trim(), levels: state.me.levels }));
    toast(ok ? 'Code copied — send it to whoever runs the map' : 'Could not copy — select the code and copy it');
  });

  document.getElementById('meAddBtn').addEventListener('click', () => {
    state.team.push({ id: uid(), name: state.me.name.trim(), levels: state.me.levels });
    save(); renderRoster(); renderTeamViz(); renderMeeting();
    showTab('team');
    toast('Added to the team');
  });

  document.getElementById('addCodeBtn').addEventListener('click', () => {
    const input = document.getElementById('pasteCode');
    const p = decodeProfile(input.value);
    if (!p) { toast('That code did not read — check it was copied whole'); return; }
    state.team.push(p);
    input.value = '';
    save(); renderRoster(); renderTeamViz(); renderMeeting();
    toast(`${p.name} added`);
  });

  document.getElementById('demoBtn').addEventListener('click', loadExample);

  document.getElementById('shareTeamBtn').addEventListener('click', async () => {
    const code = encodeState(state.team.map((p) => [p.name, p.levels]));
    const url = `${location.origin}${location.pathname}#team=${code}`;
    const ok = await copyText(url);
    toast(ok ? 'Team link copied' : 'Could not copy the link');
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
  const draft = { name: '', levels: 'cccccc' };

  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; paint(); });
  wrap.append(el('label', { class: 'field' }, [el('span', { text: 'Name' }), nameInput]));

  const rows = el('div');
  wrap.append(rows);
  const tally = el('p', { class: 'tally', style: 'margin:10px 0 0' });
  const addBtn = el('button', { class: 'btn', type: 'button', text: 'Add', disabled: 'disabled' });
  wrap.append(tally, el('div', { class: 'row', style: 'margin-top:12px' }, [addBtn]));

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
    state.team.push({ id: uid(), name: draft.name.trim(), levels: draft.levels });
    save(); renderRoster(); renderTeamViz(); renderMeeting();
    toast(`${draft.name.trim()} added`);
    draft.name = ''; draft.levels = 'cccccc'; nameInput.value = ''; paint();
  });

  paint();
}

function importFromHash() {
  const m = location.hash.match(/team=([A-Za-z0-9\-_]+)/);
  if (!m) return;
  const raw = decodeState(m[1]);
  if (!Array.isArray(raw)) return;
  const people = raw
    .filter((r) => Array.isArray(r) && validLevels(r[1]))
    .map(([name, levels]) => ({ id: uid(), name: String(name).slice(0, 40), levels }));
  if (people.length) {
    state.team = people;
    state.meeting.attendees = [];
    save();
    toast(`Loaded ${people.length} people from the link`);
  }
  history.replaceState(null, '', location.pathname);
}

/* ============================================================
   Boot
   ============================================================ */

fetch('./model.json')
  .then((r) => r.json())
  .then((m) => {
    MODEL = m;
    TYPES = m.types;
    TYPES.forEach((t, i) => { TIDX[t.id] = i; });
    state.me.levels = 'c'.repeat(TYPES.length);

    load();
    importFromHash();
    wire();
    renderMeeting();
    renderRoster();
    renderTeamViz();
    renderMe();

    // demo build: always boot into the worked example, never a stale session
    if (window.__DEMO__) {
      window.__resetDemo = () => loadExample(true);
      window.__resetDemo();
    }

    document.getElementById('modelNote').textContent = m.note;
  })
  .catch(() => {
    document.body.innerHTML = '<div class="wrap"><div class="card">Could not load the model file.</div></div>';
  });
