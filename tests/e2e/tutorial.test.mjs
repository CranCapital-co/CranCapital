// Tutorial Island needs no account and no server, so it's the safest way to
// check the 3D layer: open it, play the first steps, and fail on any console
// error or if the 3D world doesn't draw.
//
// Needs the site running (npm run dev, or set BASE to a built copy) and
// Playwright's Chromium: BASE=http://localhost:5173/ npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';

test('Tutorial Island draws the 3D world without errors', { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
    const page = await ctx.newPage();
    // A new player's head start card, if it's on: close it whenever it shows.
    await page.addLocatorHandler(page.locator('.head-start').getByRole('button', { name: /Let.s go/ }), async (b) => { await b.click(); });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      // The tutorial makes no server calls; a missing optional file (sound or
      // model manifests) is the only acceptable 404.
      if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text());
    });
    await page.goto(BASE + '#/tutorial');
    await page.waitForFunction(() => window.__ccWorld, null, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    let st = await page.evaluate(() => window.__ccWorld.stats());
    assert.ok(st.calls > 0, `3D layer draws (draw calls: ${st.calls})`);
    assert.ok(st.walkers > 5, `blob people on the island (${st.walkers})`);
    assert.equal(st.players, 0, 'no character: you play from above');
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

    // Play the first steps: straight to parking the cart (no walking).
    const tap = async (x, y) => {
      const pt = await page.evaluate(([x, y]) => window.__ccTutorialMap.project([-150 + x / 111320, 0.25 + y / 110574]), [x, y]);
      await page.mouse.click(pt.x, pt.y);
    };
    await page.getByRole('button', { name: /Let’s go/ }).click();
    await page.getByText('Park your cart').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000); // the camera glides to the square
    await tap(12, 0);
    await page.waitForTimeout(3500); // the build show
    st = await page.evaluate(() => window.__ccWorld.stats());
    assert.equal(st.businesses, 1, 'the cart is on the map in 3D');
    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    await browser.close();
  }
});
