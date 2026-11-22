// Real weather: stored per city from Open-Meteo replies, readable by anyone,
// and never touching money.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, anonClient, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

const reply = (temp, code, isDay) => ({
  current: { time: '2026-11-18T12:00', temperature_2m: temp, weather_code: code, wind_speed_10m: 14.2, is_day: isDay, rain: code >= 61 ? 1.2 : 0, snowfall: 0, cloud_cover: 80 },
});

test('weather: a reply is stored, replaced by the next, and readable without signing in', async () => {
  const a = await newPlayer('Rainy');
  const before = await one('select coalesce(sum(amount), 0)::bigint as s, count(*)::int as n from game.ledger');
  await q('select game.weather_store($1, $2)', ['london', reply(11.5, 61, 1)]);
  await q('select game.weather_store($1, $2)', ['paris', reply(8.0, 3, 0)]);
  await q('select game.weather_store($1, $2)', ['london', reply(12.25, 2, 1)]);

  const rows = await rpc(anonClient(), 'city_weather');
  const london = rows.find((r) => r.city_id === 'london');
  const paris = rows.find((r) => r.city_id === 'paris');
  assert.equal(Number(london.temp_c), 12.25, 'the newer reply wins');
  assert.equal(london.code, 2);
  assert.equal(london.is_day, true);
  assert.equal(paris.is_day, false);
  assert.equal(paris.cloud_pct, 80);

  // Signed-in players read the same thing.
  assert.equal((await rpc(a.client, 'city_weather')).length, rows.length);

  // A reply without current conditions changes nothing; the job without
  // pg_net does nothing; neither touches money.
  await q('select game.weather_store($1, $2)', ['london', { error: true }]);
  assert.equal(Number((await rpc(anonClient(), 'city_weather')).find((r) => r.city_id === 'london').temp_c), 12.25);
  await q('select game.weather_tick()');
  const after2 = await one('select coalesce(sum(amount), 0)::bigint as s, count(*)::int as n from game.ledger');
  assert.equal(after2.s, before.s);
  assert.deepEqual(await ledgerMismatches(), []);

  // Players can't write weather.
  const { error } = await a.client.rpc('weather_store', { p_city: 'london', p_body: reply(40, 0, 1) });
  assert.ok(error);
});

test('prefs: the graphics setting is kept, and only known values', async () => {
  const a = await newPlayer('Gfx');
  const prefs = await rpc(a.client, 'set_prefs', { p_prefs: { graphics: 'medium' } });
  assert.equal(prefs.graphics, 'medium');
  const again = await rpc(a.client, 'set_prefs', { p_prefs: { graphics: 'ultra-mega' } });
  assert.equal(again.graphics, 'medium', 'unknown values are ignored');
});
