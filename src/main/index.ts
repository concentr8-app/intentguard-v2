// Electron entry point: window, menu-bar item, notifications, IPC. Logic lives in controller.ts.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import path from 'node:path';
import type { AppState, Settings } from '../shared/types';
import { createGroqSemanticProvider } from '../services/groq';
import { createMacPlatform, createNullPlatform } from '../services/platform';
import { CachedSemanticClassifier } from '../services/semantic';
import { Controller } from './controller';
import { Store } from './store';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
let quitting = false;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
  h('callNow', () => c.callNow());
  h('setIntent', (task: string, time: string) => c.setIntent(task, time));
  h('startFocus', (task?: string, minutes?: number) => c.startFocus(task, minutes));
  h('stopFocus', () => c.stopFocus());
  h('takeBreak', (minutes: number) => c.takeBreak(minutes));
  h('endBreak', () => c.endBreak());
  h('saveSettings', (patch: Partial<Settings>) => c.saveSettings(patch));
  h('openExternal', (url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });
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
  controller = new Controller({ store, platform, notify, emit, showWindow, semantic, relevanceLog });
  registerIpc(controller);

  tray = new Tray(nativeImage.createEmpty());
  createWindow();
  controller.start();
  updateTray(controller.getState());

  // Keep the menu-bar countdown fresh even when nothing else changes.
  setInterval(() => controller && updateTray(controller.getState()), 30_000);
});
