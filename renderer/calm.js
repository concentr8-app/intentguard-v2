// Calm screen: box breathing. In 4, hold 4, out 4, hold 4 (16 s a round, four rounds in the calm minute).
// One clock drives the words, the count, the orb and the dot on the square, so they never drift apart.
// Esc or "I'm ready" ends it; otherwise the main process ends it. Talks to main only through window.c8.
(() => {
'use strict';

const PHASE_MS = 4000;
const PHASES = ['Breathe in', 'Hold', 'Breathe out', 'Hold'];
const SMALL = 0.5; // orb size with empty lungs
const BIG = 0.92; // orb size with full lungs, still inside the square
const LO = 4; // the square in calm.html runs from 4 to 96
const HI = 96;

const cue = document.getElementById('cue');
const count = document.getElementById('count');
const orb = document.getElementById('orb');
const dot = document.getElementById('dot');
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const start = performance.now();
let shownPhase = 0; // calm.html starts on "Breathe in"
let shownCount = 4;
let done = false;

function say(text) {
  cue.classList.add('fading');
  setTimeout(() => {
    cue.textContent = text;
    cue.classList.remove('fading');
  }, 300);
}

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

/** Orb size: grows while breathing in, stays full, shrinks while breathing out, stays empty. */
function orbScale(phase, p) {
  if (phase === 0) return SMALL + (BIG - SMALL) * ease(p);
  if (phase === 1) return BIG;
  if (phase === 2) return BIG - (BIG - SMALL) * ease(p);
  return SMALL;
}

/** Dot on the square: up the left side, across the top, down the right side, back along the bottom. */
function dotAt(phase, p) {
  const a = LO + (HI - LO) * p;
  if (phase === 0) return [LO, HI + LO - a];
  if (phase === 1) return [a, LO];
  if (phase === 2) return [HI, a];
  return [HI + LO - a, HI];
}

function frame(now) {
  const t = (now - start) % (PHASE_MS * PHASES.length);
  const phase = Math.floor(t / PHASE_MS);
  const p = (t % PHASE_MS) / PHASE_MS;

  if (phase !== shownPhase) {
    shownPhase = phase;
    say(PHASES[phase]);
  }
  const left = PHASES.length - Math.floor(p * 4); // 4, 3, 2, 1
  if (left !== shownCount) {
    shownCount = left;
    count.textContent = String(left);
  }
  if (!still) {
    const scale = orbScale(phase, p);
    orb.style.transform = `scale(${scale.toFixed(4)})`;
    orb.style.opacity = (0.7 + (0.3 * (scale - SMALL)) / (BIG - SMALL)).toFixed(3);
    const [x, y] = dotAt(phase, p);
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
  }
  requestAnimationFrame(frame);
}

function ready() {
  if (done) return;
  done = true;
  window.c8.calmDone();
}

requestAnimationFrame(frame);

document.getElementById('ready').addEventListener('click', ready);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ready();
});
})();
