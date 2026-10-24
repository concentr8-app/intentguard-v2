// Bridge between the sandboxed UI and the main process. Exposes window.c8.
// Written as a plain script (require, no import/export) because sandboxed preloads aren't ES modules.

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`c8:${channel}`, ...args);

contextBridge.exposeInMainWorld('c8', {
  state: () => invoke('state'),
  connectCanvas: (baseUrl: string, token: string) => invoke('connectCanvas', baseUrl, token),
  useDemo: () => invoke('useDemo'),
  disconnectCanvas: () => invoke('disconnectCanvas'),
  sync: () => invoke('sync'),
  connectServer: (url: string, key: string) => invoke('connectServer', url, key),
  disconnectServer: () => invoke('disconnectServer'),
  signUp: (input: unknown) => invoke('signUp', input),
  deleteAccount: () => invoke('deleteAccount'),
  callNow: () => invoke('callNow'),
  setIntent: (task: string, time: string) => invoke('setIntent', task, time),
  startFocus: (task?: string, minutes?: number) => invoke('startFocus', task, minutes),
  stopFocus: () => invoke('stopFocus'),
  takeBreak: (minutes: number) => invoke('takeBreak', minutes),
  endBreak: () => invoke('endBreak'),
  saveSettings: (patch: unknown) => invoke('saveSettings', patch),
  openExternal: (url: string) => invoke('openExternal', url),
  imStuck: () => invoke('imStuck'),
  calmDone: () => invoke('calmDone'),
  stuckAnswer: (answer: 'started' | 'smaller' | 'break') => invoke('stuckAnswer', answer),
  stuckCall: () => invoke('stuckCall'),
  skipCall: () => invoke('skipCall'),
  cancelStuck: () => invoke('cancelStuck'),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => cb(state);
    ipcRenderer.on('c8:state', listener);
    return () => ipcRenderer.removeListener('c8:state', listener);
  },
});
