// Concentr8 UI. Plain JS: the main process pushes the full AppState (see src/shared/types.ts),
// and this file paints it. Talks to main only through window.c8 (src/main/preload.ts).
// Keep bindings out of global scope because contextBridge exposes c8 as a non-configurable window property.
(() => {
'use strict';

const c8 = window.c8;
const $ = (id) => document.getElementById(id);
const { describeActivity } = window.Concentr8ActivityView;

let state = null;
let editingPlan = false;
let connectingCanvas = false; // bCourses is optional: its connect screen opens only when asked for
const painted = {}; // last HTML per list, so unchanged lists aren't re-rendered under the cursor

// ---------- helpers ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function setHTML(el, html) {
  if (painted[el.id] === html) return;
  painted[el.id] = html;
  el.innerHTML = html;
}

function tz() {
  return state?.settings.timezone || 'America/Los_Angeles';
}

function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(date); // YYYY-MM-DD
}

function clockTime(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "08:00" -> "8:00 AM" */
function hhmm12(value) {
  const [h, m] = String(value || '08:00').split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

function dueText(iso) {
  if (!iso) return { text: 'no due date', soon: false };
  const due = new Date(iso);
  const now = new Date();
  const hours = (due - now) / 3_600_000;
  if (hours < 0) return { text: 'overdue', soon: true };
  const time = clockTime(iso);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  let text;
  if (dayKey(due) === dayKey(now)) text = `due today, ${time}`;
  else if (dayKey(due) === dayKey(tomorrow)) text = `due tomorrow, ${time}`;
  else if (hours < 24 * 6) {
    text = `due ${new Intl.DateTimeFormat('en-US', { timeZone: tz(), weekday: 'short' }).format(due)}, ${time}`;
  } else {
    text = `due ${new Intl.DateTimeFormat('en-US', { timeZone: tz(), month: 'short', day: 'numeric' }).format(due)}`;
  }
  return { text, soon: hours < 24 };
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

function onBreak(session) {
  return !!(session && session.breakUntil && new Date(session.breakUntil) > new Date());
}

// ---------- painting ----------

function paint() {
  if (!state) return;
  const { settings } = state;
  const hasTasks = settings.canvasConnected || settings.demoMode;
  if (hasTasks) connectingCanvas = false;
  const showConnect = connectingCanvas && !state.session;
  $('onboarding').hidden = !showConnect;
  $('home').hidden = showConnect;

  paintStatus();
  if (!showConnect) {
    paintToday();
    paintTasks();
    paintHistory();
  }
  $('notice').textContent = state.notice || '';
}

function paintStatus() {
  const { settings, session, platformSupported } = state;
  const parts = [];
  if (settings.demoMode) parts.push('<span class="warn">Sample assignments</span>');
  else if (settings.canvasConnected) parts.push('<span class="on">bCourses connected</span>');
  else parts.push('<span>bCourses not connected</span>');

  if (settings.serverConnected) parts.push(`<span class="on">Call at ${esc(hhmm12(settings.callTime))}</span>`);
  else parts.push('<span>Morning call off</span>');

  if (!platformSupported) parts.push('<span class="warn">Screen watching needs macOS</span>');
  else if (session) parts.push('<span class="on">Watching your screen</span>');
  else parts.push('<span>Screen watching starts with a session</span>');
  setHTML($('status'), parts.join(''));
}

function paintToday() {
  const { today, session, verdict, settings } = state;
  const section = $('today');

  const stuck = session ? state.stuck : null;
  let mode = 'idle';
  if (session) {
    mode = stuck ? 'stuck' : onBreak(session) ? 'break' : verdict && verdict.kind === 'distraction' ? 'drift' : 'focus';
  }
  section.dataset.state = mode;

  const showSession = !!session;
  const showPlan = !session && !!today.focusTask && !editingPlan;
  $('session').hidden = !showSession || !!stuck;
  $('stuck').hidden = !stuck;
  if (stuck) paintStuck(stuck);
  $('plan-set').hidden = !showPlan;
  $('plan-empty').hidden = showSession || showPlan;

  if (!showSession && !showPlan) {
    updateIntentButton();
    $('call-hint').textContent = settings.serverConnected
      ? `Or pick it on the phone. Your ${hhmm12(settings.callTime)} call asks the same question.`
      : `Connect the morning call in Settings and Concentr8 asks you this on the phone at ${hhmm12(settings.callTime)}.`;
  }

  if (showPlan) {
    $('said-label').textContent =
      today.source === 'call' && today.lastCallAt ? `You said on your ${clockTime(today.lastCallAt)} call` : 'You said';
    $('said-task').textContent = today.focusTask;
    let when;
    if (today.startAt && new Date(today.startAt) > new Date()) {
      when = `Starting at ${clockTime(today.startAt)}. Focus mode turns on by itself.`;
    } else if (today.startAt) {
      when = `You planned to start at ${clockTime(today.startAt)}.`;
    } else if (today.startTime) {
      when = `Starting “${today.startTime}”.`;
    } else {
      when = 'No start time yet. Start whenever you are ready.';
    }
    $('said-when').textContent = when;
    $('call-now').hidden = !settings.serverConnected;
  }

  if (showSession && !stuck) paintSession();
}

/** One phase at a time: calm, call, step (with its timer), check-in. */
function paintStuck(stuck) {
  const { phase, step } = stuck;
  const text = $('stuck-step');
  let label = '';
  let line = '';
  let waiting = false;
  if (phase === 'calm') {
    label = 'Breathing';
    line = 'Take a minute. Nothing else.';
    waiting = true;
  } else if (phase === 'call') {
    label = 'On the phone';
    line = "Pick up. You'll find a first step together.";
  } else if (phase === 'checkin') {
    label = "Time's up";
    line = 'Did you get going?';
  } else if (!step) {
    label = 'One moment';
    line = 'Finding one small first step…';
    waiting = true;
  } else {
    label = step.source === 'call' ? `From your call, for the next ${step.minutes} minutes` : `Your next ${step.minutes} minutes`;
    line = step.text;
  }
  $('stuck-label').textContent = label;
  text.textContent = line;
  text.classList.toggle('waiting', waiting);

  const stepShown = phase === 'step' && !!step;
  $('stuck-actions').hidden = !(stepShown || phase === 'checkin');
  $('stuck-call').hidden = !(stepShown && stuck.callAvailable);
  $('call-actions').hidden = phase !== 'call';
  const open = $('stuck-open');
  open.hidden = !(step && step.url) || phase === 'call' || phase === 'calm';
  if (step && step.url) open.href = step.url;
  paintStuckClock();
}

function paintStuckClock() {
  const stuck = state?.stuck;
  const when = $('stuck-when');
  if (!stuck) return;
  if (stuck.phase === 'call') {
    when.textContent = "If the call doesn't bring a step, I'll give you one.";
    return;
  }
  if (stuck.phase !== 'step' || !stuck.step || !stuck.phaseEndsAt) {
    when.textContent = '';
    return;
  }
  const left = Math.max(0, new Date(stuck.phaseEndsAt).getTime() - Date.now());
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  when.textContent = `${m}:${String(s).padStart(2, '0')} left, then I'll check in.`;
}

function paintSession() {
  const { session, activity, verdict } = state;
  $('session-task').textContent = session.task;
  paintClock();

  const breakNow = onBreak(session);
  $('im-stuck').hidden = breakNow;
  $('stuck-hint').hidden = breakNow || !state.platformSupported;
  $('break-5').hidden = breakNow;
  $('end-break').hidden = !breakNow;

  const screen = $('screen-now');
  screen.className = 'screen';
  if (!state.platformSupported) {
    screen.textContent = 'Screen watching works on macOS only. The timer still runs.';
  } else if (breakNow) {
    screen.textContent = `Break until ${clockTime(session.breakUntil)}. Nothing gets blocked.`;
  } else if (!activity) {
    screen.textContent = 'Waiting for macOS permission to see the front app. Check System Settings → Privacy & Security → Automation.';
  } else {
    const view = describeActivity(activity, verdict);
    screen.classList.add(verdict?.kind || 'neutral');
    screen.innerHTML = `<span class="screen-copy">
      <span>${esc(view.label)}: <strong>${esc(view.app)}</strong></span>
      ${view.title ? `<span class="screen-title">${esc(view.title)}</span>` : ''}
      ${view.url ? `<code class="screen-url">${esc(view.url)}</code>` : ''}
    </span>`;
  }

  const words = { nudged: 'Warned about', blocked: 'Closed', returned: 'Came back from' };
  const items = session.drifts
    .slice(-8)
    .reverse()
    .map(
      (d) =>
        `<li><time>${esc(clockTime(d.at))}</time><span class="${d.action}">${words[d.action]} ${esc(d.target)}${
          d.action === 'returned' ? ' on your own' : ''
        }</span></li>`,
    )
    .join('');
  setHTML($('drift-log'), items);
}

function paintClock() {
  const session = state?.session;
  if (!session) return;
  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.endsAt).getTime();
  const left = Math.max(0, end - Date.now());
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  $('clock').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('track-fill').style.width = `${Math.min(100, ((Date.now() - start) / (end - start)) * 100)}%`;
}

function paintTasks() {
  const { tasks, lastSync, syncError, settings } = state;
  const line = $('sync-line');
  const hasTasks = settings.canvasConnected || settings.demoMode;
  $('sync').hidden = !hasTasks;
  if (!hasTasks) {
    line.classList.remove('bad');
    line.textContent = 'Optional. Your assignments can show up here.';
    setHTML(
      $('task-list'),
      `<li class="empty connect">
        <button class="secondary small" type="button" data-action="connect-canvas">Add your courses</button>
        <button class="link" type="button" data-action="use-demo">Add sample assignments</button>
      </li>`,
    );
    return;
  }
  line.textContent = syncError
    ? syncError
    : settings.demoMode
      ? 'Sample data. Add your courses in Settings to see your real assignments.'
      : lastSync
        ? `Synced ${ago(lastSync)}`
        : 'Syncing…';

  if (!tasks.length) {
    setHTML($('task-list'), '<li class="empty">Nothing due in the next two weeks. Enjoy it.</li>');
    return;
  }
  const html = tasks
    .slice(0, 25)
    .map((t) => {
      const due = dueText(t.dueAt);
      const title = t.url ? `<a href="${esc(t.url)}" data-external>${esc(t.title)}</a>` : esc(t.title);
      return `<li>
        <div>
          <div class="task-title">${title}</div>
          <div class="task-meta">${esc(t.course)}, <span class="${due.soon ? 'soon' : ''}">${esc(due.text)}</span></div>
        </div>
        <button class="secondary small" type="button" data-start="${esc(t.id)}">Start</button>
      </li>`;
    })
    .join('');
  setHTML($('task-list'), html);
}

function paintHistory() {
  const html = state.history
    .slice(0, 6)
    .map((h) => {
      const caught = h.drifts + h.blocks;
      const stuck = h.stuck
        ? `, stuck ${h.stuck === 1 ? 'once' : `${h.stuck} times`}${h.gotGoing ? ' and got going' : ''}`
        : '';
      return `<li><strong>${esc(h.task)}</strong> ${h.minutes} min${
        caught ? `, ${caught} distraction${caught === 1 ? '' : 's'} caught` : ', no distractions'
      }${stuck}</li>`;
    })
    .join('');
  setHTML($('history'), html);
}

// ---------- settings drawer ----------

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function openSettings() {
  const s = state.settings;
  $('canvas-status').textContent = s.demoMode
    ? 'Using sample assignments.'
    : s.canvasConnected && s.canvasFeed
      ? 'Connected through your calendar feed. Submitted work still shows until its due date passes.'
      : s.canvasConnected
        ? `Connected as ${s.canvasUserName || 'you'} (${hostOf(s.canvasBaseUrl)}).`
        : 'Not connected.';
  $('server-url').value = s.serverUrl || '';
  $('server-key').value = '';
  $('server-key').placeholder = s.serverConnected ? 'Saved. Paste a new key to replace it.' : 'The APP_API_KEY you set on Replit';
  $('signup-form').hidden = s.serverConnected;
  $('connected-block').hidden = !s.serverConnected;
  $('own-server').hidden = s.serverConnected;
  $('signup-error').textContent = '';
  $('delete-error').textContent = '';
  $('call-now-status').textContent = '';
  $('invite-code').value = '';
  $('call-consent').checked = false;
  $('server-error').textContent = '';
  $('phone').value = s.phoneNumber || '';
  $('call-time').value = s.callTime;
  $('grace').value = s.graceSeconds;
  $('session-minutes').value = s.sessionMinutes;
  $('blocked-domains').value = s.rules.blockedDomains.join('\n');
  $('blocked-apps').value = s.rules.blockedApps.join('\n');
  $('allowed-domains').value = s.rules.allowedDomains.join('\n');
  $('platform-note').textContent = state.platformSupported
    ? 'macOS asks once whether Concentr8 may control your browser. Allow it, or blocking can’t work. Firefox also needs Accessibility access in System Settings → Privacy & Security.'
    : 'Screen watching and blocking work on macOS only.';
  $('canvas-open').hidden = s.canvasConnected;
  $('canvas-disconnect').hidden = !s.canvasConnected && !s.demoMode;
  $('saved-note').textContent = '';
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  $('close-settings').focus();
}

function closeSettings() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  $('open-settings').focus();
}

const lines = (id) =>
  $(id)
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

async function saveSettings() {
  const grace = Number($('grace').value);
  const minutes = Number($('session-minutes').value);
  await c8.saveSettings({
    phoneNumber: $('phone').value.trim(),
    callTime: $('call-time').value || '08:00',
    graceSeconds: Number.isFinite(grace) ? Math.min(120, Math.max(0, grace)) : 15,
    sessionMinutes: Number.isFinite(minutes) && minutes >= 5 ? Math.min(180, minutes) : 50,
    rules: {
      blockedDomains: lines('blocked-domains'),
      blockedApps: lines('blocked-apps'),
      allowedDomains: lines('allowed-domains'),
    },
  });
  $('saved-note').textContent = 'Saved';
}

// ---------- events ----------

function busy(button, fn) {
  return async (event) => {
    event?.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await fn();
    } finally {
      button.disabled = false;
    }
  };
}

$('canvas-form').addEventListener(
  'submit',
  busy($('canvas-connect'), async () => {
    $('canvas-error').textContent = '';
    const result = await c8.connectCanvas($('canvas-url').value, $('canvas-token').value);
    if (!result.ok) $('canvas-error').textContent = result.error;
    else $('canvas-token').value = '';
  }),
);
$('use-demo').addEventListener('click', busy($('use-demo'), () => c8.useDemo()));

function openConnect() {
  connectingCanvas = true;
  paint();
  $('canvas-token').focus();
}

function closeConnect() {
  connectingCanvas = false;
  $('canvas-error').textContent = '';
  paint();
}

$('canvas-back').addEventListener('click', closeConnect);

/** No time, or "now": the task starts right away. A time: it's planned and starts by itself. */
function startsNow() {
  const time = $('intent-time').value.trim();
  return !time || /^now$/i.test(time);
}

function updateIntentButton() {
  $('intent-submit').textContent = startsNow() ? 'Start now' : 'Plan it';
}

$('intent-time').addEventListener('input', updateIntentButton);

$('intent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = $('intent-task').value.trim();
  if (!task) return;
  editingPlan = false;
  if (startsNow()) {
    await c8.setIntent(task, '');
    await c8.startFocus(task);
  } else {
    await c8.setIntent(task, $('intent-time').value.trim());
  }
  $('intent-time').value = '';
  updateIntentButton();
});

$('change-plan').addEventListener('click', () => {
  editingPlan = true;
  $('intent-task').value = state.today.focusTask || '';
  $('intent-time').value = state.today.startTime || '';
  paint();
  $('intent-task').focus();
});

$('start-focus').addEventListener('click', () => c8.startFocus());
async function requestCallNow(status) {
  if (status) status.textContent = '';
  const r = await c8.callNow();
  if (!r.ok) {
    state.notice = r.error;
    if (status) status.textContent = r.error;
    paint();
  } else if (status) {
    status.textContent = 'Calling your phone now…';
  }
}

$('call-now').addEventListener('click', busy($('call-now'), () => requestCallNow()));
$('call-now-settings').addEventListener(
  'click',
  busy($('call-now-settings'), () => requestCallNow($('call-now-status'))),
);
$('im-stuck').addEventListener('click', () => c8.imStuck());
$('stuck-actions').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-stuck]');
  if (button) c8.stuckAnswer(button.dataset.stuck);
});
$('stuck-call').addEventListener(
  'click',
  busy($('stuck-call'), async () => {
    const r = await c8.stuckCall();
    if (!r.ok) {
      state.notice = r.error;
      paint();
    }
  }),
);
$('skip-call').addEventListener('click', () => c8.skipCall());
$('cancel-stuck').addEventListener('click', () => c8.cancelStuck());
$('break-5').addEventListener('click', () => c8.takeBreak(5));
$('end-break').addEventListener('click', () => c8.endBreak());
$('stop-focus').addEventListener('click', () => c8.stopFocus());
$('sync').addEventListener('click', busy($('sync'), () => c8.sync()));

$('task-list').addEventListener('click', async (e) => {
  const action = e.target.closest('button[data-action]');
  if (action?.dataset.action === 'connect-canvas') return openConnect();
  if (action?.dataset.action === 'use-demo') return c8.useDemo();
  const button = e.target.closest('button[data-start]');
  if (!button) return;
  const task = state.tasks.find((t) => t.id === button.dataset.start);
  if (!task) return;
  if (!state.today.focusTask) await c8.setIntent(task.title, 'now');
  await c8.startFocus(task.title);
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-external], a[href^="http"]');
  if (!link) return;
  e.preventDefault();
  c8.openExternal(link.href);
});

$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('scrim').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden) closeSettings();
});
$('save-settings').addEventListener('click', busy($('save-settings'), saveSettings));

$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('server-error').textContent = '';
  const key = $('server-key').value.trim();
  if (!key) {
    $('server-error').textContent = 'Paste the API key you set as APP_API_KEY on Replit.';
    return;
  }
  const r = await c8.connectServer($('server-url').value.trim(), key);
  if (!r.ok) $('server-error').textContent = r.error;
  else {
    await saveSettings(); // also sends phone number and call time to the server
    $('server-key').value = '';
    $('server-disconnect').hidden = false;
    $('saved-note').textContent = 'Server connected';
  }
});
$('server-disconnect').addEventListener('click', async () => {
  await c8.disconnectServer();
  $('signup-form').hidden = false;
  $('connected-block').hidden = true;
  $('own-server').hidden = false;
});
$('signup-form').addEventListener(
  'submit',
  busy($('signup-button'), async () => {
    $('signup-error').textContent = '';
    if (!$('call-consent').checked) {
      $('signup-error').textContent = 'Tick the box to confirm you want the morning call.';
      return;
    }
    const r = await c8.signUp({
      serverUrl: $('server-url').value.trim(),
      inviteCode: $('invite-code').value.trim(),
      phoneNumber: $('phone').value.trim(),
      callTime: $('call-time').value || '08:00',
    });
    if (!r.ok) {
      $('signup-error').textContent = r.error;
      return;
    }
    await saveSettings();
    $('signup-form').hidden = true;
    $('connected-block').hidden = false;
    $('own-server').hidden = true;
    $('saved-note').textContent = 'Morning calls are on';
  }),
);
$('delete-account').addEventListener('click', async () => {
  $('delete-error').textContent = '';
  if (!window.confirm('Stop the morning calls and delete your account on the call server?')) return;
  const r = await c8.deleteAccount();
  if (!r.ok) {
    $('delete-error').textContent = r.error;
    return;
  }
  $('signup-form').hidden = false;
  $('connected-block').hidden = true;
  $('own-server').hidden = false;
});
$('canvas-open').addEventListener('click', () => {
  closeSettings();
  openConnect();
});
$('canvas-disconnect').addEventListener('click', async () => {
  await c8.disconnectCanvas();
  closeSettings();
});

// ---------- start ----------

c8.onState((next) => {
  state = next;
  if (editingPlan && state.session) editingPlan = false;
  paint();
});
c8.state().then((initial) => {
  state = initial;
  paint();
});
setInterval(() => {
  paintClock();
  paintStuckClock();
}, 1000);
})();
