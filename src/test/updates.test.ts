import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Controller } from '../main/controller';
import { Store } from '../main/store';
import { assetFor, checkForUpdate, compareVersions, RELEASES_PAGE } from '../services/updates';

const release = (tag: string, names: string[]) =>
  (async () => new Response(JSON.stringify({ tag_name: tag, assets: names.map((name) => ({ name })) }), { status: 200 })) as unknown as typeof fetch;

test('compareVersions orders clean versions and treats anything else as older', () => {
  assert.equal(compareVersions('1.0.4', '1.0.5'), -1);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.4', '1.0.4'), 0);
  assert.equal(compareVersions('development', '1.0.0'), -1);
});

test('assetFor matches the release workflow file names', () => {
  assert.equal(assetFor('darwin', 'arm64'), 'Concentr8-arm64.dmg');
  assert.equal(assetFor('darwin', 'x64'), 'Concentr8-x64.dmg');
  assert.equal(assetFor('win32', 'x64'), 'Concentr8-x64.exe');
  assert.equal(assetFor('linux', 'x64'), 'Concentr8-x64.AppImage');
});

test('checkForUpdate: only a newer release, with the download for this computer', async () => {
  const all = ['Concentr8-arm64.dmg', 'Concentr8-x64.dmg', 'Concentr8-x64.exe', 'Concentr8-x64.AppImage'];
  assert.deepEqual(await checkForUpdate('1.0.4', 'darwin', 'arm64', release('v1.0.5', all)), {
    version: '1.0.5',
    url: 'https://github.com/concentr8-app/concentr8/releases/latest/download/Concentr8-arm64.dmg',
  });
  assert.equal(await checkForUpdate('1.0.5', 'darwin', 'arm64', release('v1.0.5', all)), null, 'same version');
  assert.equal(await checkForUpdate('1.0.6', 'darwin', 'arm64', release('v1.0.5', all)), null, 'older release');
  assert.equal((await checkForUpdate('1.0.4', 'win32', 'x64', release('v1.0.5', ['Concentr8-arm64.dmg'])))?.url, RELEASES_PAGE, 'no file for this computer: the release page');
  assert.equal(await checkForUpdate('development', 'darwin', 'arm64', release('v9.9.9', all)), null, 'development builds do not nag');
  const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate('1.0.4', 'darwin', 'arm64', failing), null, 'offline: nothing');
  const limited = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  assert.equal(await checkForUpdate('1.0.4', 'darwin', 'arm64', limited), null, 'rate limit: nothing');
});

test('the controller shows a newer version in the app state, and a failed check changes nothing', async () => {
  const plainCrypto = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'c8-update-')), plainCrypto);
  let answer: { version: string; url: string } | null = { version: '1.0.5', url: 'https://example.test/Concentr8-arm64.dmg' };
  let emitted = 0;
  const controller = new Controller({
    appVersion: '1.0.4',
    store,
    platform: { supported: false, activity: async () => null, redirect: async () => false, closeTab: async () => false, hideApp: async () => false },
    notify: () => {},
    emit: () => emitted++,
    showWindow: () => {},
    checkUpdate: async () => answer,
  });
  assert.equal(controller.getState().update, null);
  await controller.checkUpdate();
  assert.deepEqual(controller.getState().update, answer);
  assert.equal(emitted, 1);
  answer = null;
  await controller.checkUpdate();
  assert.equal(controller.getState().update, null, 'the newest version is installed again');
});
