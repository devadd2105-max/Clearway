// Clearway Lunar — a short guided tour that follows the demo storyline:
// question → compare → map → why → horizon → when → trade-offs → uncertainty → trust → explain & play.

export const TOUR = [
  { sel: '#verdict', title: 'The question', text: 'Which landing site gives our lander the best chance of surviving its surface mission while keeping contact with Earth? Clearway answers it here: a site, a landing date, whether the battery makes it through the stay, and how often it survives when things go wrong.' },
  { sel: '#card-rank', title: 'Compare the sites', text: 'Every candidate is scored on sunlight and Earth-link time over the search period. The strip shows who is recommended at every mission priority — a site that wins across the whole strip is a safer choice than one that wins only at one end.' },
  { sel: '#card-map', title: 'NASA data, on a map', text: 'NASA laser-altimeter terrain, NASA\'s 18.6-year average-sunlight map and the permanently shadowed craters where water ice can survive. Click a site to select it, or click empty ground to add a new candidate there.' },
  { sel: '#card-why', title: 'Why this site?', text: 'The recommendation explains itself: strengths and weaknesses against the other sites, the head-to-head trade-off with the runner-up, and the single constraint that limits it.' },
  { sel: '#card-site', title: 'The horizon view', text: 'The geometry behind every number. The skyline is real terrain; the dashed line is what a smooth Moon would give. Press Play: when the Sun or Earth sinks behind a ridge, power, heaters, battery and the link all change together. Below: slopes from NASA\'s 5 m maps and the distance to ice.', action: 'play' },
  { sel: '#card-cal', title: 'When to land', text: 'Each square is a landing day. Green survives the whole stay, red runs the battery flat, grey has the Sun or Earth behind the terrain at touchdown. Click a day to see its limiting constraint.' },
  { sel: '#card-trade', title: 'Trade-offs', text: 'Pick two or more sites, a landing time and a stay. Change the stay length or the priority: the explorer recomputes and says in plain words what changed and why.' },
  { sel: '#card-mc', title: 'Survival under uncertainty', text: 'Each site\'s planned landing is replayed hundreds of times with a late landing, a touchdown 100 m off target, terrain error, weaker panels, hungrier loads, an aged battery and a steep landing spot. Robust sites survive nearly every replay.' },
  { sel: '#card-conf', title: 'How much to trust it', text: 'What is modelled, assumed and not modelled; whether the recommendation survives perturbed inputs; and a measured comparison with NASA\'s own published illumination maps.' },
  { sel: '#card-verify', title: 'Evidence', text: 'Sun and Earth positions are checked against NASA JPL Horizons to arc-seconds, every 5 m map is checked against the LOLA grid, and the full automated test suite result is shown.' },
  { sel: '.seg.mode', title: 'Three ways to use Clearway', text: 'Simple asks four questions about your lander and gives one answer. Planner is this full board. Explain adds plain-language notes on every chart for classrooms — then try the Landing Director challenge: make the GO / HOLD / SCRUB calls for a landing at the selected site and date. "About" lists every data source.' },
];

export function startTour(root, { onStep } = {}) {
  let i = 0;
  const card = root.querySelector('.tour-card');
  const prev = root.querySelector('#tour-prev'), next = root.querySelector('#tour-next'), end = root.querySelector('#tour-end');
  let lit = null;
  const show = () => {
    const s = TOUR[i];
    lit?.classList.remove('tour-hi');
    lit = document.querySelector(s.sel);
    if (lit) { lit.classList.add('tour-hi'); lit.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    root.querySelector('#tour-step').textContent = `Step ${i + 1} of ${TOUR.length}`;
    root.querySelector('#tour-title').textContent = s.title;
    root.querySelector('#tour-text').textContent = s.text;
    prev.disabled = i === 0;
    next.textContent = i === TOUR.length - 1 ? 'Finish' : 'Next';
    onStep?.(s, i);
  };
  const close = () => { lit?.classList.remove('tour-hi'); root.hidden = true; prev.onclick = next.onclick = end.onclick = null; document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') next.click(); if (e.key === 'ArrowLeft' && i > 0) prev.click(); };
  prev.onclick = () => { if (i > 0) { i--; show(); } };
  next.onclick = () => { if (i < TOUR.length - 1) { i++; show(); } else close(); };
  end.onclick = close;
  document.addEventListener('keydown', key);
  root.hidden = false;
  card.focus?.();
  show();
  return close;
}
