// Clearway — Launch Director Challenge.
// A timed countdown in which the player makes GO / HOLD / SCRUB calls as conditions change.
// Events are built from the team's real analysis where possible (its weather limits, the
// actual close approaches and the hold optimiser), so the game teaches the same launch
// commit rules the planner applies.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clock = (s) => { const a = Math.abs(Math.round(s)); return `T${s <= 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; };

/** Build the event list for one round. */
export function buildEvents(ctx) {
  const L = ctx.limits || { surfaceWindMs: 15, upperWindMs: 60 };
  const ev = [];
  ev.push({ at: -540, title: 'Range poll', text: 'Range safety, tracking and the flight termination system all report ready.', correct: ['GO'], why: 'Every station is ready and nothing violates a launch commit criterion: the correct call is GO.' });
  const windBad = Math.random() < 0.5;
  const upper = windBad ? L.upperWindMs + 4 + Math.round(Math.random() * 8) : Math.round(L.upperWindMs * (0.6 + Math.random() * 0.3));
  ev.push({ at: -420, title: 'Weather balloon', text: `Latest balloon shows upper-level winds of ${upper} m/s at 11 km. Vehicle limit: ${L.upperWindMs} m/s. ${ctx.windowMin > 20 ? `About ${ctx.windowMin} minutes of window remain.` : 'This is an instantaneous window.'}`,
    correct: windBad ? (ctx.windowMin > 20 ? ['HOLD', 'SCRUB'] : ['SCRUB']) : ['GO'],
    why: windBad ? 'Upper-level winds above the vehicle limit risk structural loads during max-Q. You cannot launch through it: hold for a new balloon if the window allows, otherwise scrub.' : 'Winds are inside the vehicle limit, so they do not constrain the launch.' });
  const c = ctx.conjunction;
  if (c) {
    ev.push({ at: -300, title: 'Collision avoidance update', text: `Updated screening: ${c.name} (NORAD ${c.norad}) passes ${c.miss.toFixed(2)} km from the vehicle at ${clock(c.tau)}, Pc ${c.pc.toExponential(1)}.${c.hold != null ? ` The hold optimiser clears it with a ${c.hold > 0 ? '+' : ''}${c.hold} s hold.` : ''}`,
      correct: c.risky ? (c.hold != null ? ['HOLD'] : ['SCRUB', 'HOLD']) : ['GO'],
      why: c.risky ? 'A collision-avoidance closure is in effect: launching into it breaks the COLA rule. A short hold that moves T-0 out of the closure is the efficient call.' : 'The approach is outside the no-go distance and below the Pc threshold, so the window stays open.' });
  } else {
    ev.push({ at: -300, title: 'Collision avoidance update', text: 'Updated screening from the space surveillance service: no closures for this T-0.', correct: ['GO'], why: 'No COLA closure affects this T-0.' });
  }
  const lightning = Math.random() < 0.45;
  ev.push(lightning
    ? { at: -150, title: 'Lightning detection', text: `Cloud-to-ground strike detected 9 km from the pad. ${ctx.windowMin > 35 ? `${ctx.windowMin} minutes of window remain.` : `Only ${Math.max(1, ctx.windowMin)} minutes of window remain.`}`, correct: ctx.windowMin > 35 ? ['HOLD'] : ['SCRUB'], why: 'Lightning launch commit criteria forbid launch within 30 minutes of a strike within 10 nautical miles (18.5 km). Hold if 30 minutes fit in the window; otherwise scrub.' }
    : { at: -150, title: 'Field mill readings', text: 'Electric field mills read normal (below 1 kV/m). No lightning within 30 km in the last hour.', correct: ['GO'], why: 'Normal field mill readings and no nearby strikes: lightning rules are met.' });
  const dropout = pick([
    { text: 'Ground station reports a 3-second telemetry dropout from the vehicle. Link re-established, all parameters nominal.', correct: ['GO'], why: 'A brief dropout that recovers with nominal data does not violate a commit criterion.' },
    { text: 'Second-stage tank pressure reading is outside its red-line limit and not recovering.', correct: ['HOLD', 'SCRUB'], why: 'A red-line violation on vehicle data is an automatic hold. Investigate; scrub if it cannot be cleared in the window.' },
  ]);
  ev.push({ at: -45, title: 'Vehicle status', ...dropout });
  ev.push({ at: -10, title: 'Final poll', text: 'Launch director: all positions report GO for launch.', correct: ['GO'], why: 'Final poll is GO across the board.' });
  return ev;
}

export function startGame(root, ctx, { onClose } = {}) {
  const events = ctx.events || buildEvents(ctx);
  const SPEED = 10; // simulated seconds per real second
  let t = -600, idx = 0, score = 0, running = true, paused = false, timer = null, deadline = 0;
  const log = [];
  root.innerHTML = `
    <div class="countdown" id="g-clock">${clock(t)}<small>${esc(ctx.mission || 'Mission')} · ${esc(ctx.subtitle || `window ${ctx.windowMin} min`)}</small></div>
    <div class="score"><span>Score <b id="g-score">0</b></span><span id="g-phase">Countdown running</span></div>
    <div id="g-event"></div>
    <ol class="log" id="g-log"></ol>`;
  const $ = (s) => root.querySelector(s);

  const finish = (outcome) => {
    running = false; clearInterval(timer);
    const correct = log.filter((l) => l.ok).length;
    $('#g-event').innerHTML = `<div class="event" style="border-color:var(${outcome === 'launch' ? '--go' : '--caution'})">
      <h3>${outcome === 'launch' ? esc(ctx.successLabel || 'Liftoff') : outcome === 'scrub' ? 'Scrubbed' : 'Countdown stopped'}</h3>
      <p>${correct} of ${log.length} calls correct · final score <b>${score}</b>.</p>
      <div class="choices"><button class="btn primary" type="button" id="g-again">Play again</button><button class="btn" type="button" id="g-done">Close</button></div></div>`;
    $('#g-again').addEventListener('click', () => startGame(root, ctx, { onClose }));
    $('#g-done').addEventListener('click', () => onClose?.());
  };

  const showEvent = (e) => {
    paused = true; deadline = performance.now() + 12000;
    $('#g-phase').textContent = 'Decision required';
    $('#g-event').innerHTML = `<div class="event"><h3>${esc(e.title)} · ${clock(t)}</h3><p>${esc(e.text)}</p>
      <div class="timer"><i id="g-timer" style="width:100%"></i></div>
      <div class="choices"><button class="btn go" data-c="GO">GO</button><button class="btn hold" data-c="HOLD">HOLD</button><button class="btn scrub" data-c="SCRUB">SCRUB</button></div></div>`;
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => answer(e, b.dataset.c)));
  };

  const answer = (e, choice) => {
    if (!paused) return;
    const left = Math.max(0, deadline - performance.now());
    const ok = choice != null && e.correct.includes(choice);
    const pts = ok ? 100 + Math.round((left / 12000) * 50) : -100;
    score += pts; log.push({ e, choice, ok, pts });
    $('#g-score').textContent = String(score);
    $('#g-log').insertAdjacentHTML('beforeend', `<li><b class="s-${ok ? 'GO' : 'NO-GO'}">${ok ? 'Correct' : 'Wrong'}</b> ${esc(e.title)}: you called ${choice || 'nothing'} (${pts > 0 ? '+' : ''}${pts}). ${esc(e.why)}</li>`);
    paused = false; idx++;
    $('#g-event').innerHTML = '';
    $('#g-phase').textContent = choice === 'HOLD' ? 'Holding, then recycling the count' : 'Countdown running';
    if (choice === 'SCRUB') return finish('scrub');
    if (idx >= events.length && t > -15) return finish('launch');
  };

  timer = setInterval(() => {
    if (!running) return;
    if (paused) {
      const frac = Math.max(0, (deadline - performance.now()) / 12000);
      const bar = $('#g-timer'); if (bar) bar.style.width = `${frac * 100}%`;
      if (frac <= 0) answer(events[idx], null);
      return;
    }
    t += SPEED * 0.1;
    $('#g-clock').firstChild.textContent = clock(t);
    if (idx < events.length && t >= events[idx].at) showEvent(events[idx]);
    else if (idx >= events.length && t >= 0) finish('launch');
  }, 100);

  return () => { running = false; clearInterval(timer); };
}
