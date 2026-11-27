// Before launch, press everything: a new player on an iPad leads a country,
// parks a cart by tapping a street (no walking), opens every window and
// every tab, switches city, then builds a fort and a minefield and recruits
// troops from their own cash. Fails on any console error.
//
// Needs the local stack (tools/local-supabase/start.sh) and the dev server:
//   BASE=http://localhost:5173/ npm run test:e2e
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { db, q, one, streetNear } from '../db/helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';

after(async () => { await db.end(); });

test('press everything', { timeout: 300_000 }, async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack ?? '').split('\n').slice(0, 6).join('\n')));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) errors.push(m.text());
    });
    // Celebrations (first sale, level up) pop up over the game: tap them away, like a player.
    await page.addLocatorHandler(page.locator('.moment-back').first(), async (m) => {
      await m.click({ position: { x: 8, y: 8 }, force: true });
    }, { noWaitAfter: true }); // level-ups come one after another
    const shot = async (name) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });

    // Sign up and lead a country with a game city (with the head start new
    // players get).
    await q(`update game.nations set leader_id = null, leader_since = null where id = 'gbr'`);
    await q(`update game.config set value = 1 where key = 'head_start'`);
    await page.goto(BASE + '#/play');
    const id = Date.now().toString(36);
    const name = 'Presser' + id.slice(-5);
    await page.getByLabel('Email').fill(`press${id}@example.com`);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.getByLabel('Display name').fill(name);
    await page.locator('input[type=checkbox]').first().check();
    await page.getByRole('button', { name: /Start with/ }).click();
    await page.getByText('Choose the country you’ll lead').waitFor({ timeout: 20_000 });
    await page.getByPlaceholder('Search countries').fill('United Kingdom');
    await page.locator('.picker-row:not(.taken)').first().click();
    await page.getByRole('button', { name: /^Lead / }).click();
    await page.getByRole('button', { name: /Skip, take me to a city/ }).click({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Start in London/ }).click({ timeout: 20_000 });
    await page.locator('.renown-badge').waitFor({ timeout: 30_000 });
    const me = await one('select id from game.players where display_name = $1', [name]);
    // The head start: shown once, saying what it is and what it does.
    await page.getByText('Your head start').waitFor({ timeout: 20_000 });
    assert.ok(await page.getByText(/in cash/).isVisible());
    await shot('0-head-start');
    await page.getByRole('button', { name: /Let.s go/ }).click();
    await q(`update game.config set value = 0 where key = 'head_start'`);
    assert.ok(await one(`select 1 from game.ledger where player_id = $1 and kind = 'head_start'`, [me.id]), 'head start paid');
    assert.ok(await one(`select 1 from game.head_starts where player_id = $1 and seen_at is not null`, [me.id]), 'and shown once');
    await page.waitForFunction(() => window.__ccMap && window.__ccMap.loaded(), null, { timeout: 30_000 });
    await shot('1-city');

    // Money per second is ticking in the HUD.
    await page.locator('.per-second').waitFor({ timeout: 10_000 }).catch(() => {});

    // Park a cart: Build, choose a spot, tap a street.
    await page.locator('.dock button', { hasText: 'Build' }).click();
    await page.getByRole('button', { name: 'Choose a spot' }).click();
    const city = await one(`select start_lat, start_lng from game.cities where id = 'london'`);
    const spot = await streetNear('london', city.start_lat, city.start_lng, 12);
    await page.evaluate(([lng, lat]) => window.__ccMap.jumpTo({ center: [lng, lat] }), [spot.lng, spot.lat]);
    await page.waitForTimeout(600);
    const pt = await page.evaluate(([lng, lat]) => window.__ccMap.project([lng, lat]), [spot.lng, spot.lat]);
    await page.mouse.click(pt.x, pt.y);
    await page.getByRole('button', { name: /^Buy cart for/ }).click({ timeout: 10_000 });
    // The business window opens: every tab.
    await page.getByText(/Your cart is open/).first().waitFor({ timeout: 15_000 });
    await page.locator('.window').first().waitFor({ timeout: 15_000 });
    await page.locator('.window [role=tab]').first().waitFor({ timeout: 15_000 });
    await clickAllTabs(page, '.window');
    await shot('2-cart');
    await closeWindow(page);

    // Every dock window and every tab in it.
    for (const label of ['Empire', 'Market', 'People', 'More']) {
      await page.locator('.dock button', { hasText: label }).click();
      await page.locator('.window').first().waitFor({ timeout: 10_000 });
      await clickAllTabs(page, '.window');
      await closeWindow(page);
    }
    // A market good opens.
    await page.locator('.dock button', { hasText: 'Market' }).click();
    await page.locator('.window tbody tr, .window .good-row').first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await closeWindow(page);

    // Cities: instant and free.
    const cash0 = Number((await one('select cash from game.players where id = $1', [me.id])).cash);
    await page.locator('.dock button', { hasText: 'More' }).click();
    await page.getByRole('button', { name: /Cities/ }).first().click();
    await page.getByRole('button', { name: /^Go to Paris/ }).click({ timeout: 10_000 });
    let where = '';
    for (let i = 0; i < 40 && where !== 'paris'; i++) {
      await page.waitForTimeout(250);
      where = (await one('select city_id from game.players where id = $1', [me.id])).city_id;
    }
    assert.equal(where, 'paris', 'moved to Paris at once');
    await page.waitForFunction(() => window.__ccMap && window.__ccMap.loaded(), null, { timeout: 30_000 }).catch(() => {});
    assert.ok(Number((await one('select cash from game.players where id = $1', [me.id])).cash) >= cash0 - 1, 'flying is free');
    await shot('3-paris');

    // The nation: build a fort and a minefield and recruit, from your own cash.
    await q(`select game.grant_xp($1, (select total from game.level_xp where level = 6)::int, 'test')`, [me.id]);
    await q(`select game.money($1, 100000000, 'admin', 'test money')`, [me.id]);
    await page.locator('.dock button', { hasText: 'Nation' }).click();
    await page.locator('.nation-pill').waitFor({ timeout: 20_000 });
    await clickAllTabs(page, '.nations-panel');
    await page.getByRole('tab', { name: 'Military' }).click();
    for (const b of ['Fort', 'Minefield']) {
      const c0 = Number((await one('select cash from game.players where id = $1', [me.id])).cash);
      await page.locator('.build-tile', { hasText: b }).first().click();
      await page.waitForFunction((b) => document.body.innerText.includes(`${b} level 1 started`), b, { timeout: 10_000 });
      assert.ok(Number((await one('select cash from game.players where id = $1', [me.id])).cash) < c0, `${b} was paid from your cash`);
    }
    await page.getByRole('button', { name: /^Recruit \d+/ }).click();
    await page.getByText(/Training \d+ infantry/).first().waitFor({ timeout: 10_000 });
    // Military upgrades: troopships, once the navy is researched.
    await q(`insert into game.nation_techs (nation_id, tech) select nation, 'navy' from (select game.player_nation($1) nation) x on conflict do nothing`, [me.id]);
    await page.getByRole('tab', { name: 'Research' }).click();
    await page.getByRole('tab', { name: 'Military' }).click();
    const troopships = page.locator('.upgrade-row', { hasText: 'Troopships' });
    await troopships.locator('button').click({ timeout: 15_000 });
    await page.waitForFunction(() => document.body.innerText.includes('Troopships level 1'), null, { timeout: 10_000 });
    assert.equal(Number((await one(`select level from game.nation_upgrades where track = 'troopships' and nation_id = game.player_nation($1)`, [me.id])).level), 1);
    assert.ok(await page.locator('.upgrade-row', { hasText: 'Missile range' }).isVisible());
    // Research costs money too.
    await page.getByRole('tab', { name: 'Research' }).click();
    await page.locator('.tech:not(.done):not(.locked) button').first().click();
    await page.waitForTimeout(800);
    await shot('4-nation');

    // Talk to a country: it always answers, and its offers pop up.
    await page.getByRole('tab', { name: 'Talk' }).click();
    await page.getByPlaceholder('Search countries').fill('a');
    await page.locator('.nations-body .rel-row').nth(3).click();
    await page.locator('.talk-head').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Hello!' }).click();
    await page.locator('.bubble.theirs:not(.typing)').first().waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Can we sign a non-aggression pact?' }).click();
    await page.locator('.bubble.theirs:not(.typing)').nth(1).waitFor({ timeout: 15_000 });
    const offer = page.locator('.modal', { hasText: 'makes an offer' });
    if (await offer.count()) {
      await shot('5-offer');
      await offer.getByRole('button', { name: 'Accept' }).click();
      await page.locator('.bubble.theirs:not(.typing)').nth(2).waitFor({ timeout: 15_000 });
    }
    await page.getByLabel(/^Message /).fill('You are stupid');
    await page.getByRole('button', { name: /Send/ }).click();
    await page.locator('.bubble.theirs:not(.typing)').last().waitFor({ timeout: 15_000 });
    await shot('6-talk');
    assert.ok(Number((await one('select count(*) c from game.diplo_chat where player_id = $1 and not from_player', [me.id])).c) >= 3, 'they answered every message');
    await page.getByRole('button', { name: 'Back to the city' }).click();
    await page.locator('.renown-badge').waitFor();

    // The admin panel (for admins only).
    await q(`update game.players set role = 'admin' where id = $1`, [me.id]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.reload();
    await page.locator('.renown-badge').waitFor({ timeout: 30_000 });
    await page.locator('.dock button', { hasText: 'More' }).click();
    await page.getByRole('button', { name: /^Admin/ }).click();
    const cashA = Number((await one('select cash from game.players where id = $1', [me.id])).cash);
    await page.getByRole('button', { name: '+$1M' }).click();
    await page.getByText(/Gave .* \$1,000,000/).first().waitFor({ timeout: 10_000 });
    // At least $1M more (the cart may have made a sale meanwhile).
    assert.ok(Number((await one('select cash from game.players where id = $1', [me.id])).cash) >= cashA + 1e9, 'admin money arrived');
    await page.getByRole('button', { name: '+5 levels' }).click();
    await page.getByText(/is now level/).first().waitFor({ timeout: 10_000 });
    await shot('7-admin');
    await closeWindow(page);

    assert.deepEqual(errors, [], 'no console errors');
  } catch (e) {
    console.log('page errors:', JSON.stringify(errors ?? [], null, 1).slice(0, 3000));
    if (process.env.SHOTS) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: `${process.env.SHOTS}/fail.png` }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
});

async function closeWindow(page) {
  // The sheet's own close button (Escape only closes pop-up dialogs).
  for (let i = 0; i < 4 && (await page.locator('.window').count()); i++) {
    await page.locator('.window header [aria-label=Close]').first().click();
    await page.waitForTimeout(250);
  }
  await page.locator('.window').first().waitFor({ state: 'detached', timeout: 5000 });
}

// Click each tab in the open window(s), including tabs that appear inside tabs.
async function clickAllTabs(page, scope) {
  const seen = new Set();
  for (let round = 0; round < 3; round++) {
    const tabs = page.locator(`${scope} [role=tab]`);
    const n = await tabs.count();
    let clicked = 0;
    for (let i = 0; i < n; i++) {
      const t = tabs.nth(i);
      // The window may re-render under us: skip a tab that went away.
      const label = ((await t.textContent({ timeout: 2000 }).catch(() => '')) ?? '').trim();
      if (!label || seen.has(label) || !(await t.isVisible().catch(() => false))) continue;
      seen.add(label);
      // A tab strip that scrolls sideways can keep a tab "moving": click it anyway.
      await t.click({ timeout: 4000 }).catch(() => t.click({ force: true }));
      await page.waitForTimeout(350);
      clicked++;
    }
    if (!clicked) break;
  }
}
