// Calm screen: words follow the orb (4 s in, 6 s out). Esc or "I'm ready" ends it;
// otherwise the main process ends it after a minute. Talks to main only through window.c8.
(() => {
'use strict';

const INHALE_MS = 4000;
const EXHALE_MS = 6000;
const cue = document.getElementById('cue');
let done = false;

function say(text) {
  cue.classList.add('fading');
  setTimeout(() => {
    cue.textContent = text;
    cue.classList.remove('fading');
  }, 300);
}

function cycle() {
  say('Breathe in');
  setTimeout(() => say('Breathe out'), INHALE_MS);
}

function ready() {
  if (done) return;
  done = true;
  window.c8.calmDone();
}

cycle();
setInterval(cycle, INHALE_MS + EXHALE_MS);

document.getElementById('ready').addEventListener('click', ready);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ready();
});
})();
