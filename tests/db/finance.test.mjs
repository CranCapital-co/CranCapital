// Phase 5: loans, player banks, shares, events.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, q, one, newPlayer, rpc, rpcError, ledgerMismatches } from './helpers.mjs';

after(async () => { await db.end(); });

test('city bank loan: credit limit, automatic repayments, early repayment', async () => {
  const a = await newPlayer('Borrower');
  const quote = await rpc(a.client, 'list_banks');
  assert.ok(quote.credit_limit >= 2900000 && quote.credit_limit <= 3100000, `30% of $10k: ${quote.credit_limit}`);
  assert.match(await rpcError(a.client, 'take_loan', { p_bank: null, p_amount: 5000000, p_days: 10 }), /borrow up to/);
  const loan = await rpc(a.client, 'take_loan', { p_bank: null, p_amount: 2000000, p_days: 10 });
  assert.equal((await rpc(a.client, 'get_me')).cash, 12000000);
  await q(`update game.loans set last_charge_at = now() - interval '1 day' where id = $1`, [loan.loan_id]);
  await q('select game.finance_tick()');
  const l = await one('select * from game.loans where id = $1', [loan.loan_id]);
  assert.ok(Number(l.outstanding) < 2000000, 'an instalment was paid');
  await rpc(a.client, 'repay_loan', { p_loan: loan.loan_id });
  const done = await one('select status from game.loans where id = $1', [loan.loan_id]);
  assert.equal(done.status, 'repaid');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('player bank lends capital; interest flows back to the bank', async () => {
  const banker = await newPlayer('Banker');
  const client2 = await newPlayer('Client');
  await q('update game.players set tier = 6 where id = $1', [banker.id]);
  await q(`select game.money($1, 3000000000, 'admin', 'test funds')`, [banker.id]);
  const bld = await one(`select b.* from game.buildings b where city_id = 'london' and not landmark and rooms_total > 3 order by id limit 1 offset 5`);
  await q('update game.players set lat = $2, lng = $3, pos_at = now() where id = $1', [banker.id, bld.lat, bld.lng]);
  const bank = await rpc(banker.client, 'rent_room', { p_building: bld.id, p_kind: 'bank', p_name: 'First Bank', p_lat: bld.lat, p_lng: bld.lng });
  await rpc(banker.client, 'bank_deposit', { p_bank: bank.business_id, p_amount: 500000000 });
  await rpc(banker.client, 'bank_set_terms', { p_bank: bank.business_id, p_rate_daily: 1.5, p_max_loan: 2000000, p_max_days: 7 });
  const banks = await rpc(client2.client, 'list_banks');
  assert.ok(banks.banks.some((b) => b.bank_id === bank.business_id));
  assert.match(await rpcError(banker.client, 'take_loan', { p_bank: bank.business_id, p_amount: 1000000, p_days: 3 }), /own bank/);
  const loan = await rpc(client2.client, 'take_loan', { p_bank: bank.business_id, p_amount: 2000000, p_days: 5 });
  const cap0 = (await one('select capital from game.bank_accounts where business_id = $1', [bank.business_id])).capital;
  await q(`update game.loans set last_charge_at = now() - interval '1 day' where id = $1`, [loan.loan_id]);
  await q('select game.finance_tick()');
  const cap1 = (await one('select capital from game.bank_accounts where business_id = $1', [bank.business_id])).capital;
  assert.ok(BigInt(cap1) > BigInt(cap0), 'repayment plus interest went into the bank');
  assert.deepEqual(await ledgerMismatches(), []);
});

test('IPO, share trading and dividends', async () => {
  const owner = await newPlayer('Founder');
  const investor = await newPlayer('Investor');
  await q('update game.players set tier = 6 where id = $1', [owner.id]);
  await q('update game.players set tier = 2 where id = $1', [investor.id]);
  await q(`select game.money($1, 100000000, 'admin', 'test funds')`, [owner.id]);
  const ipo = await rpc(owner.client, 'ipo', { p_name: 'Founder Foods', p_price: 5000, p_shares: 100000 });
  const buy = await rpc(investor.client, 'place_share_order', { p_symbol: ipo.symbol, p_side: 'buy', p_qty: 1000, p_price: 5000 });
  assert.equal(buy.filled, 1000);
  const before = (await rpc(investor.client, 'get_me')).cash;
  await rpc(owner.client, 'pay_dividend', { p_per_share: 100 });
  const after_ = (await rpc(investor.client, 'get_me')).cash;
  assert.equal(after_ - before, 100000, '1,000 shares x $0.10');
  const sell = await rpc(investor.client, 'place_share_order', { p_symbol: ipo.symbol, p_side: 'sell', p_qty: 500, p_price: 6000 });
  assert.equal(sell.resting, 500);
  assert.match(await rpcError(investor.client, 'place_share_order', { p_symbol: ipo.symbol, p_side: 'sell', p_qty: 5000, p_price: 6000 }), /don't have that many/);
  const mkt = await rpc(investor.client, 'share_market');
  assert.ok(mkt.companies.some((c) => c.symbol === ipo.symbol));
  assert.deepEqual(await ledgerMismatches(), []);
});

test('events change how many customers come', async () => {
  const staff = await newPlayer('EventStaff');
  await q(`update game.players set role = 'admin' where id = $1`, [staff.id]);
  await rpc(staff.client, 'admin_create_event', { p_city: 'london', p_kind: 'festival' });
  const m = await one(`select game.event_mult('london', 'street') m`);
  assert.ok(Number(m.m) >= 1.39);
  const ev = await rpc(staff.client, 'world_events');
  assert.ok(ev.some((e) => e.city_id === 'london' && e.active));
  await q(`delete from game.events where city_id = 'london'`);
});
