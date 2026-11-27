// A new player's first minutes with Renown and Nations, on an iPad: sign in,
// choose a country on the world map, reach the city, collect the daily
// reward, then open the nation screen and its tabs. Fails on any console
// error.
//
// Needs the local stack (tools/local-supabase/start.sh) and the dev server:
//   BASE=http://localhost:5173/ npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';

test('choose a country, earn Renown and run your nation', { timeout: 180_000 }, async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
    const page = await ctx.newPage();
    // A new player's head start card, if it's on: close it whenever it shows.
    await page.addLocatorHandler(page.locator('.head-start').getByRole('button', { name: /Let.s go/ }), async (b) => { await b.click(); });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text());
    });
    await page.goto(BASE + '#/play');
    const id = Date.now().toString(36);
    await page.getByLabel('Email').fill(`nations${id}@example.com`);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.getByLabel('Display name').fill('Leader' + id.slice(-5));
    await page.locator('input[type=checkbox]').first().check();
    await page.getByRole('button', { name: /Start with/ }).click();

    // The world map and the list of free countries.
    await page.getByText('Choose the country you’ll lead').waitFor({ timeout: 20_000 });
    const rows = page.locator('.picker-row:not(.taken)');
    await rows.first().waitFor({ timeout: 20_000 });
    await page.getByPlaceholder('Search countries').fill('Europe');
    await rows.nth(3).click();
    const lead = page.getByRole('button', { name: /^Lead / });
    const country = (await lead.textContent()).replace(/^\s*Lead\s*/, '').trim();
    await lead.click();

    // Into a city: the Renown badge is in the HUD, with a reward waiting.
    await page.getByRole('button', { name: /Skip, take me to a city/ }).click({ timeout: 20_000 });
    // Straight to the country's own city (or the nearest one).
    await page.getByRole('button', { name: /^Start in / }).click({ timeout: 20_000 });
    await page.locator('.renown-badge').waitFor({ timeout: 30_000 });
    await page.locator('.renown-badge .dot').waitFor({ timeout: 10_000 });
    await page.locator('.renown-badge').click();
    await page.getByRole('button', { name: /Collect day 1/ }).click({ timeout: 15_000 });
    await page.getByText(/Collected today/).waitFor({ timeout: 10_000 });
    for (const t of ['Missions', 'Perks', 'Achievements', 'Season']) {
      await page.getByRole('tab', { name: new RegExp('^' + t) }).click();
    }
    await page.keyboard.press('Escape');

    // The nation screen: your country, its army, research, diplomacy, the world.
    await page.locator('.dock button', { hasText: 'Nation' }).click();
    await page.locator('.nation-pill', { hasText: country }).waitFor({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Military' }).click();
    await page.getByRole('button', { name: /^Recruit \d+/ }).click();
    await page.getByText(/Training \d+ infantry/).first().waitFor({ timeout: 10_000 });
    await page.getByRole('tab', { name: 'Research' }).click();
    await page.getByRole('tab', { name: /^Diplomacy/ }).click();
    await page.getByRole('tab', { name: 'World' }).click();
    await page.locator('.rank-row').first().waitFor({ timeout: 15_000 });
    await page.locator('.rank-row').nth(1).click();
    await page.locator('.selected-card').waitFor({ timeout: 10_000 });
    // Back to the city.
    await page.getByRole('button', { name: 'Back to the city' }).click();
    await page.locator('.renown-badge').waitFor();
    assert.deepEqual(errors, [], 'no console errors');
  } finally {
    await browser.close();
  }
});
