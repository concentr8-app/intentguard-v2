// Accessibility check (WCAG 2.2 A and AA rules of axe-core) for the website and the app screens, in light and dark.
// Run after `npm run build`:  node scripts/a11y-check.js
// Needs playwright and axe-core: CI installs them; locally set PLAYWRIGHT_PATH / AXE_PATH if they live elsewhere.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const axeSource = fs.readFileSync(process.env.AXE_PATH || require.resolve('axe-core/axe.min.js'), 'utf8');
const { Controller } = require(path.join(root, 'dist/main/controller.js'));
const { Store } = require(path.join(root, 'dist/main/store.js'));

/** Real app states from the real Controller, so the check sees what students see. */
function appStates() {
  const plain = { available: () => false, encrypt: (s) => s, decrypt: (s) => s };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'c8-a11y-')), plain);
  store.updateSettings({ demoMode: true, timezone: 'America/Los_Angeles' });
  const platform = { supported: true, activity: async () => null, redirect: async () => false, closeTab: async () => false, hideApp: async () => false };
  const c = new Controller({ appVersion: '1.0.4', store, platform, notify() {}, emit() {}, showWindow() {} });
  const home = c.getState();
  return {
    home,
    'home with update': { ...home, update: { version: '1.0.5', url: 'https://github.com/concentr8-app/concentr8/releases/latest' } },
    onboarding: { ...home, settings: { ...home.settings, demoMode: false, canvasConnected: false } },
  };
}

function stub(state) {
  // Every bridge call resolves; state() returns the given state.
  return `window.c8 = new Proxy({}, { get: (_, name) => name === 'state' ? async () => (${JSON.stringify(state)})
    : name === 'onState' ? () => () => {} : async () => ({ ok: true }) });`;
}

async function audit(page, label) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ': ' + (n.failureSummary || '').split('\n')[1]) }));
  });
  for (const v of result) {
    console.log(`  ✗ [${label}] ${v.id} (${v.impact}): ${v.help}`);
    for (const n of v.nodes) console.log(`      ${n}`);
  }
  if (!result.length) console.log(`  ✓ ${label}`);
  return result.length;
}

(async () => {
  const site = fs.readFileSync(path.join(root, 'server/public/index.html'), 'utf8').split('{{DOWNLOAD_BASE}}').join('https://github.com/concentr8-app/concentr8/releases/latest/download');
  const siteFile = path.join(os.tmpdir(), 'c8-site.html');
  fs.writeFileSync(siteFile, site);
  const states = appStates();
  const browser = await chromium.launch();
  let problems = 0;
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce', bypassCSP: true });
    const page = await ctx.newPage();
    await page.route(/^https?:\/\//, (r) => r.abort()); // no network: fonts fall back, GitHub lookups fail quietly
    await page.goto('file://' + siteFile);
    await page.waitForTimeout(300);
    problems += await audit(page, `website, ${scheme}`);
    // The website looks different per computer (Mac, Windows, phone), so check each version.
    for (const [who, userAgent, viewport] of [
      ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { width: 1280, height: 800 }],
      ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', { width: 1280, height: 800 }],
      ['phone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', { width: 390, height: 844 }],
    ]) {
      const c2 = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce', bypassCSP: true, userAgent, viewport });
      const p2 = await c2.newPage();
      await p2.route(/^https?:\/\//, (r) => r.abort());
      await p2.goto('file://' + siteFile);
      await p2.waitForTimeout(300);
      problems += await audit(p2, `website on ${who}, ${scheme}`);
      await c2.close();
    }
    for (const [name, state] of Object.entries(states)) {
      await page.addInitScript({ content: stub(state) });
      await page.goto('file://' + path.join(root, 'renderer/index.html'));
      await page.waitForTimeout(400);
      problems += await audit(page, `app ${name}, ${scheme}`);
      if (name === 'home') {
        await page.click('#open-settings').catch(() => {});
        await page.waitForTimeout(300);
        problems += await audit(page, `app settings, ${scheme}`);
      }
    }
    await page.goto('file://' + path.join(root, 'renderer/calm.html'));
    await page.waitForTimeout(300);
    problems += await audit(page, `calm screen, ${scheme}`);
    await ctx.close();
  }
  await browser.close();
  console.log(problems ? `\n${problems} accessibility problem(s)` : '\nNo accessibility problems found');
  process.exit(problems ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
