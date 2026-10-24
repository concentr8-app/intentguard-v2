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
  const needsCanvas = !settings.canvasConnected && !settings.demoMode;
  $('onboarding').hidden = !needsCanvas;
  $('home').hidden = needsCanvas;

  paintStatus();
  if (!needsCanvas) {
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

  let mode = 'idle';
  if (session) mode = onBreak(session) ? 'break' : verdict && verdict.kind === 'distraction' ? 'drift' : 'focus';
  section.dataset.state = mode;

  const showSession = !!session;
  const showPlan = !session && !!today.focusTask && !editingPlan;
  $('session').hidden = !showSession;
  $('plan-set').hidden = !showPlan;
  $('plan-empty').hidden = showSession || showPlan;

  if (!showSession && !showPlan) {
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

  if (showSession) paintSession();
}

function paintSession() {
  const { session, activity, verdict } = state;
  $('session-task').textContent = session.task;
  paintClock();

  const breakNow = onBreak(session);
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
  line.classList.toggle('bad', !!syncError);
  line.textContent = syncError
    ? syncError
    : settings.demoMode
      ? 'Sample data. Connect bCourses in Settings for your real courses.'
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
      return `<li><strong>${esc(h.task)}</strong> ${h.minutes} min${
        caught ? `, ${caught} distraction${caught === 1 ? '' : 's'} caught` : ', no distractions'
      }</li>`;
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
  $('server-disconnect').hidden = !s.serverConnected;
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

$('intent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = $('intent-task').value.trim();
  if (!task) return;
  editingPlan = false;
  await c8.setIntent(task, $('intent-time').value.trim());
});

$('change-plan').addEventListener('click', () => {
  editingPlan = true;
  $('intent-task').value = state.today.focusTask || '';
  $('intent-time').value = state.today.startTime || '';
  paint();
  $('intent-task').focus();
});

$('start-focus').addEventListener('click', () => c8.startFocus());
$('call-now').addEventListener(
  'click',
  busy($('call-now'), async () => {
    const r = await c8.callNow();
    if (!r.ok) {
      state.notice = r.error;
      paint();
    }
  }),
);
$('break-5').addEventListener('click', () => c8.takeBreak(5));
$('end-break').addEventListener('click', () => c8.endBreak());
$('stop-focus').addEventListener('click', () => c8.stopFocus());
$('sync').addEventListener('click', busy($('sync'), () => c8.sync()));

$('task-list').addEventListener('click', async (e) => {
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
  $('server-disconnect').hidden = true;
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
setInterval(paintClock, 1000);
})();
