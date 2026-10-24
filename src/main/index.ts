// Electron entry point: window, menu-bar item, notifications, IPC. Logic lives in controller.ts.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } from 'electron';
import path from 'node:path';
import type { AppState, Settings } from '../shared/types';
import { createGroqSemanticProvider } from '../services/groq';
import { createMacPlatform, createNullPlatform } from '../services/platform';
import { CachedSemanticClassifier } from '../services/semantic';
import { createStepProvider } from '../services/stuck';
import { Controller } from './controller';
import { loadLocalEnv } from './env';
import { Store } from './store';

let win: BrowserWindow | null = null;
let calmWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
let quitting = false;

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function openExternal(url: string) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
}

if (!app.isPackaged) loadLocalEnv();

if (!app.requestSingleInstanceLock()) app.quit();

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    title: 'Concentr8',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f8f2',
    webPreferences: webPreferences(),
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Closing the window keeps Concentr8 running in the menu bar (it has to keep watching).
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });
}

/** "I'm stuck": a full-screen calm screen on the display the student is using. */
function openCalm() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const calm = new BrowserWindow({
    ...display.bounds,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#13211b',
    title: 'Breathe',
    webPreferences: webPreferences(),
  });
  calmWin = calm;
  calm.setAlwaysOnTop(true, 'screen-saver'); // above other windows, the Dock and the menu bar
  calm.loadFile(path.join(__dirname, '..', '..', 'renderer', 'calm.html'));
  calm.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  calm.webContents.on('will-navigate', (event) => event.preventDefault());
  calm.once('ready-to-show', () => {
    if (calm.isDestroyed()) return;
    if (process.platform === 'darwin') calm.setSimpleFullScreen(true); // covers the screen without a new Space
    calm.show();
    calm.focus();
    app.focus({ steal: true });
  });
  // Closed any other way (Cmd+W, crash): treat it like "I'm ready". No-op once the controller moved on.
  calm.on('closed', () => {
    if (calmWin === calm) calmWin = null;
    if (!quitting) controller?.calmDone();
  });
}

function syncCalm(state: AppState) {
  const wanted = state.stuck?.phase === 'calm';
  if (wanted && !calmWin) openCalm();
  if (!wanted && calmWin) {
    const calm = calmWin;
    calmWin = null;
    if (!calm.isDestroyed()) calm.destroy();
  }
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', showWindow);
  n.show();
}

function formatRemaining(state: AppState): string {
  const s = state.session;
  if (!s) return '';
  const ms = Date.parse(s.endsAt) - Date.now();
  const min = Math.max(0, Math.ceil(ms / 60_000));
  const onBreak = s.breakUntil && Date.parse(s.breakUntil) > Date.now();
  return onBreak ? `☕ ${min}m` : `● ${min}m`;
}

function updateTray(state: AppState) {
  if (!tray) return;
  tray.setTitle(state.session ? `${formatRemaining(state)}  ${truncate(state.session.task, 22)}` : 'C8');
  tray.setToolTip(state.session ? `Focus: ${state.session.task}` : 'Concentr8');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Concentr8', click: showWindow },
      { type: 'separator' },
      state.session
        ? { label: 'Stop focus', click: () => controller?.stopFocus() }
        : { label: 'Start focus', click: () => controller?.startFocus() },
      { label: "I'm stuck", enabled: !!state.session && !state.stuck, click: () => controller?.imStuck() },
      { label: 'Break 5 min', enabled: !!state.session, click: () => controller?.takeBreak(5) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function emit(state: AppState) {
  updateTray(state);
  syncCalm(state);
  if (win && !win.isDestroyed()) win.webContents.send('c8:state', state);
}

function registerIpc(c: Controller) {
  const h = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`c8:${channel}`, (_event, ...args: any[]) => fn(...args));

  h('state', () => c.getState());
  h('connectCanvas', (baseUrl: string, token: string) => c.connectCanvas(baseUrl, token));
  h('useDemo', () => c.useDemo());
  h('disconnectCanvas', () => c.disconnectCanvas());
  h('sync', () => c.syncCanvas());
  h('connectServer', (url: string, key: string) => c.connectServer(url, key));
  h('disconnectServer', () => c.disconnectServer());
  h('signUp', (input: { serverUrl?: string; inviteCode: string; phoneNumber: string; callTime: string }) => c.signUp(input));
  h('deleteAccount', () => c.deleteAccount());
  h('callNow', () => c.callNow());
  h('setIntent', (task: string, time: string) => c.setIntent(task, time));
  h('startFocus', (task?: string, minutes?: number) => c.startFocus(task, minutes));
  h('stopFocus', () => c.stopFocus());
  h('takeBreak', (minutes: number) => c.takeBreak(minutes));
  h('endBreak', () => c.endBreak());
  h('saveSettings', (patch: Partial<Settings>) => c.saveSettings(patch));
  h('openExternal', (url: string) => openExternal(url));
  h('imStuck', () => c.imStuck('button'));
  h('calmDone', () => c.calmDone());
  h('stuckAnswer', (answer: unknown) => {
    if (answer === 'started' || answer === 'smaller' || answer === 'break') c.stuckAnswer(answer);
  });
  h('stuckCall', () => c.stuckCall());
  h('skipCall', () => c.skipCall());
  h('cancelStuck', () => c.cancelStuck());
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  controller?.stopTimers();
});

app.whenReady().then(() => {
  const store = new Store(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  });
  const platform = process.platform === 'darwin' ? createMacPlatform() : createNullPlatform();
  const relevanceLog = (message: string) => console.info(message);
  const semantic = new CachedSemanticClassifier(createGroqSemanticProvider(), relevanceLog);
  const stepProvider = createStepProvider();
  console.info(stepProvider ? `[stuck] step provider=${stepProvider.name} model=${stepProvider.model}` : '[stuck] fixed steps only');
  controller = new Controller({
    store,
    platform,
    notify,
    emit,
    showWindow,
    semantic,
    relevanceLog,
    stepProvider,
    openUrl: openExternal,
    log: (message) => console.info(message),
  });
  registerIpc(controller);

  tray = new Tray(nativeImage.createEmpty());
  createWindow();
  controller.start();
  updateTray(controller.getState());

  // Keep the menu-bar countdown fresh even when nothing else changes.
  setInterval(() => controller && updateTray(controller.getState()), 30_000);
});
