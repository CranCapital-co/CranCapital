-- CranCapital finance (tier 6) and world events.
--
-- Loans: from the city bank (anyone, up to 30% of net worth, money enters
-- the game) or from player-run banks (tier 6 owners lend their bank's
-- capital at rates they set; money moves between players). Repayments are
-- taken automatically every minute: interest plus an even share of the
-- principal. A loan more than 7 days of instalments behind defaults: the
-- lender loses the rest and the borrower can't borrow for 30 days.
--
-- Shares: a tier-6 player can take their company public, selling up to 49%
-- of 1,000,000 shares through a share order book. Shareholders can trade
-- shares and receive dividends the owner declares.
--
-- Events: timed changes to a city's crowds (festivals, heatwaves, strikes).

insert into game.config (key, value, note) values
  ('city_loan_rate_daily', 0.8, 'City bank interest, % per day'),
  ('credit_limit_pct', 30, 'Most you can owe in total, % of net worth'),
  ('default_days', 7, 'Days of missed instalments before a loan defaults'),
  ('bank_max_rate_daily', 5, 'Highest daily interest a player bank may charge, %'),
  ('ipo_max_pct', 49, 'Most of a company that can be sold to the public, %'),
  ('share_count', 1000000, 'Shares in every company');

create table game.bank_accounts (
  business_id bigint primary key references game.businesses(id),
  capital bigint not null default 0 check (capital >= 0),
  rate_daily numeric not null default 1.0,
  max_loan bigint not null default 100000000,
  max_days int not null default 14
);

create table game.loans (
  id bigint generated always as identity primary key,
  bank_id bigint references game.businesses(id),
  lender_id uuid references game.players(id),
  borrower_id uuid not null references game.players(id),
  principal bigint not null check (principal > 0),
  outstanding bigint not null,
  rate_daily numeric not null,
  term_days int not null,
  started_at timestamptz not null default now(),
  last_charge_at timestamptz not null default now(),
  missed bigint not null default 0,
  missed_since timestamptz,
  status text not null default 'active' check (status in ('active', 'repaid', 'defaulted')),
  closed_at timestamptz
);
create index loans_borrower_idx on game.loans (borrower_id) where status = 'active';
create index loans_bank_idx on game.loans (bank_id) where status = 'active';

alter table game.players add column credit_blocked_until timestamptz;

-- Assets and debts from finance, added to net worth.
create function game.finance_net_worth(p_player uuid) returns bigint
language plpgsql stable set search_path = game, pg_temp as $$
begin
  return coalesce((select sum(ba.capital) from game.bank_accounts ba join game.businesses b on b.id = ba.business_id
                    where b.owner_id = p_player and b.status in ('open', 'closed')), 0)::bigint
       + coalesce((select sum(l.outstanding) from game.loans l join game.businesses b on b.id = l.bank_id
                    where b.owner_id = p_player and l.status = 'active'), 0)::bigint
       - coalesce((select sum(outstanding) from game.loans where borrower_id = p_player and status = 'active'), 0)::bigint
       + coalesce((select sum(h.qty * coalesce(c.last_price, c.ipo_price, 0)) from game.shareholdings h join game.companies c on c.owner_id = h.company_id
                    where h.holder_id = p_player and h.company_id <> p_player), 0)::bigint
       + coalesce((select sum(escrow) from game.share_orders where player_id = p_player and status = 'open' and side = 'buy'), 0)::bigint;
end $$;

create function game.debt(p_player uuid) returns bigint
language sql stable set search_path = game, pg_temp as $$
  select coalesce(sum(outstanding), 0)::bigint from game.loans where borrower_id = p_player and status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Banks
-- ---------------------------------------------------------------------------
create function game.my_bank(p game.players, p_id bigint) returns game.bank_accounts
language plpgsql set search_path = game, pg_temp as $$
declare
  b game.businesses := game.my_business(p, p_id);
  ba game.bank_accounts;
begin
  if b.kind <> 'bank' then perform game.fail('That isn''t a bank.'); end if;
  insert into game.bank_accounts (business_id) values (b.id) on conflict do nothing;
  select * into ba from game.bank_accounts where business_id = b.id for update;
  return ba;
end $$;

create function public.bank_deposit(p_bank bigint, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ba game.bank_accounts := game.my_bank(p, p_bank);
begin
  if p_amount is null or p_amount <= 0 then perform game.fail('Enter an amount.'); end if;
  perform game.money(p.id, -p_amount, 'bank_deposit', 'Capital into your bank', jsonb_build_object('bank', p_bank));
  update game.bank_accounts set capital = capital + p_amount where business_id = p_bank;
  return jsonb_build_object('capital', ba.capital + p_amount);
end $$;

create function public.bank_withdraw(p_bank bigint, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ba game.bank_accounts := game.my_bank(p, p_bank);
begin
  if p_amount is null or p_amount <= 0 then perform game.fail('Enter an amount.'); end if;
  if p_amount > ba.capital then perform game.fail(format('The bank only holds %s that isn''t lent out.', game.fmt(ba.capital))); end if;
  update game.bank_accounts set capital = capital - p_amount where business_id = p_bank;
  perform game.money(p.id, p_amount, 'bank_withdraw', 'Capital out of your bank', jsonb_build_object('bank', p_bank));
  return jsonb_build_object('capital', ba.capital - p_amount);
end $$;

create function public.bank_set_terms(p_bank bigint, p_rate_daily numeric, p_max_loan bigint, p_max_days int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ba game.bank_accounts := game.my_bank(p, p_bank);
begin
  if p_rate_daily is null or p_rate_daily < 0.05 or p_rate_daily > game.cfg('bank_max_rate_daily') then
    perform game.fail(format('Set a daily rate between 0.05%% and %s%%.', game.cfg('bank_max_rate_daily')));
  end if;
  if p_max_loan is null or p_max_loan < 1000000 then perform game.fail('The largest loan must be at least $1,000.'); end if;
  if p_max_days is null or p_max_days < 1 or p_max_days > 60 then perform game.fail('Loans can run 1 to 60 days.'); end if;
  update game.bank_accounts set rate_daily = p_rate_daily, max_loan = p_max_loan, max_days = p_max_days where business_id = p_bank;
  return jsonb_build_object('ok', true);
end $$;

create function public.list_banks() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_nw bigint;
begin
  v_nw := greatest(0, p.net_worth + game.debt(p.id));
  return jsonb_build_object(
    'city', jsonb_build_object('rate_daily', game.cfg('city_loan_rate_daily'), 'max_days', 30),
    'credit_limit', round(v_nw * game.cfg('credit_limit_pct') / 100.0),
    'debt', game.debt(p.id),
    'blocked_until', p.credit_blocked_until,
    'banks', (select coalesce(jsonb_agg(jsonb_build_object('bank_id', b.id, 'name', b.name, 'city_id', b.city_id,
        'owner_name', pl.display_name, 'owner_no', pl.player_no, 'rate_daily', ba.rate_daily, 'max_loan', least(ba.max_loan, ba.capital),
        'max_days', ba.max_days, 'mine', b.owner_id = p.id) order by ba.rate_daily), '[]'::jsonb)
      from game.bank_accounts ba join game.businesses b on b.id = ba.business_id join game.players pl on pl.id = b.owner_id
     where b.status = 'open' and ba.capital > 0)
  );
end $$;

create function public.take_loan(p_bank bigint, p_amount bigint, p_days int) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ba game.bank_accounts;
  b game.businesses;
  v_limit bigint;
  v_rate numeric;
  v_id bigint;
begin
  perform game.rate_limit(p.id::text, 'loan', 3, 0.5);
  if p.credit_blocked_until is not null and p.credit_blocked_until > now() then
    perform game.fail('You defaulted on a loan recently, so nobody will lend to you until ' || to_char(p.credit_blocked_until, 'DD Mon') || '.');
  end if;
  if p_amount is null or p_amount < 100000 then perform game.fail('Borrow at least $100.'); end if;
  if p_days is null or p_days < 1 or p_days > 60 then perform game.fail('Choose 1 to 60 days.'); end if;
  v_limit := round(greatest(0, game.refresh_worth(p.id) + game.debt(p.id)) * game.cfg('credit_limit_pct') / 100.0) - game.debt(p.id);
  if p_amount > v_limit then
    perform game.fail(format('You can borrow up to %s more (%s%% of your net worth, minus what you owe).', game.fmt(greatest(v_limit, 0)), game.cfg('credit_limit_pct')));
  end if;
  if p_bank is null then
    if p_days > 30 then perform game.fail('The city bank lends for up to 30 days.'); end if;
    v_rate := game.cfg('city_loan_rate_daily');
    insert into game.loans (borrower_id, principal, outstanding, rate_daily, term_days)
    values (p.id, p_amount, p_amount, v_rate, p_days) returning id into v_id;
    perform game.money(p.id, p_amount, 'npc_loan', format('City bank loan over %s days', p_days), jsonb_build_object('loan', v_id));
  else
    select * into ba from game.bank_accounts where business_id = p_bank for update;
    select * into b from game.businesses where id = p_bank and kind = 'bank' and status = 'open';
    if not found or ba.business_id is null then perform game.fail('That bank isn''t open.'); end if;
    if b.owner_id = p.id then perform game.fail('You can''t borrow from your own bank.'); end if;
    if p_amount > least(ba.max_loan, ba.capital) then perform game.fail(format('This bank lends up to %s right now.', game.fmt(least(ba.max_loan, ba.capital)))); end if;
    if p_days > ba.max_days then perform game.fail(format('This bank lends for up to %s days.', ba.max_days)); end if;
    update game.bank_accounts set capital = capital - p_amount where business_id = p_bank;
    insert into game.loans (bank_id, lender_id, borrower_id, principal, outstanding, rate_daily, term_days)
    values (p_bank, b.owner_id, p.id, p_amount, p_amount, ba.rate_daily, p_days) returning id into v_id;
    perform game.money(p.id, p_amount, 'loan', format('Loan from %s', b.name), jsonb_build_object('loan', v_id));
    perform game.notify(b.owner_id, 'bank', format('%s borrowed %s', p.display_name, game.fmt(p_amount)),
      format('From %s at %s%% a day over %s days.', b.name, ba.rate_daily, p_days), jsonb_build_object('loan', v_id));
  end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('loan_id', v_id, 'rate_daily', coalesce(v_rate, ba.rate_daily));
end $$;

create function game.pay_lender(l game.loans, p_amount bigint, p_interest bigint) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  if l.bank_id is null then
    -- City bank: money leaves the game.
    null;
  else
    update game.bank_accounts set capital = capital + p_amount where business_id = l.bank_id;
    if p_interest > 0 then
      update game.businesses set revenue_today = revenue_today + p_interest, lifetime_revenue = lifetime_revenue + p_interest where id = l.bank_id;
    end if;
  end if;
end $$;

create function public.repay_loan(p_loan bigint, p_amount bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  l game.loans;
  v_pay bigint;
begin
  select * into l from game.loans where id = p_loan and borrower_id = p.id and status = 'active' for update;
  if not found then perform game.fail('Loan not found.'); end if;
  v_pay := least(coalesce(p_amount, l.outstanding), l.outstanding);
  if v_pay <= 0 then perform game.fail('Enter an amount.'); end if;
  perform game.money(p.id, -v_pay, case when l.bank_id is null then 'npc_loan_repay' else 'loan_repay' end, 'Loan repayment', jsonb_build_object('loan', l.id));
  perform game.pay_lender(l, v_pay, 0);
  update game.loans set outstanding = outstanding - v_pay, missed = greatest(0, missed - v_pay),
         missed_since = case when missed - v_pay <= 0 then null else missed_since end,
         status = case when outstanding - v_pay <= 0 then 'repaid' else 'active' end,
         closed_at = case when outstanding - v_pay <= 0 then now() end
   where id = l.id;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('outstanding', l.outstanding - v_pay);
end $$;

create function public.my_loans() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object(
    'borrowed', (select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('lender', coalesce((select name from game.businesses where id = l.bank_id), 'City bank'))
                   order by l.started_at desc), '[]'::jsonb)
                   from game.loans l where l.borrower_id = p.id and (l.status = 'active' or l.closed_at > now() - interval '14 days')),
    'banks', (select coalesce(jsonb_agg(jsonb_build_object('bank_id', b.id, 'name', b.name, 'capital', ba.capital, 'rate_daily', ba.rate_daily,
                'max_loan', ba.max_loan, 'max_days', ba.max_days,
                'lent', (select coalesce(sum(outstanding), 0) from game.loans where bank_id = b.id and status = 'active'),
                'loans', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'borrower', (select display_name from game.players where id = l.borrower_id),
                            'outstanding', l.outstanding, 'rate_daily', l.rate_daily, 'missed', l.missed, 'status', l.status, 'started_at', l.started_at)), '[]'::jsonb)
                            from game.loans l where l.bank_id = b.id and (l.status = 'active' or l.closed_at > now() - interval '14 days')))), '[]'::jsonb)
                from game.businesses b left join game.bank_accounts ba on ba.business_id = b.id
               where b.owner_id = p.id and b.kind = 'bank' and b.status in ('open', 'closed'))
  );
end $$;

-- ---------------------------------------------------------------------------
-- Shares
-- ---------------------------------------------------------------------------
create table game.companies (
  owner_id uuid primary key references game.players(id),
  symbol text not null unique,
  name text not null,
  ipo_at timestamptz,
  ipo_price bigint,
  last_price bigint,
  dividends_paid bigint not null default 0
);

create table game.shareholdings (
  company_id uuid not null references game.companies(owner_id),
  holder_id uuid not null references game.players(id),
  qty bigint not null check (qty >= 0),
  primary key (company_id, holder_id)
);

create table game.share_orders (
  id bigint generated always as identity primary key,
  company_id uuid not null references game.companies(owner_id),
  player_id uuid not null references game.players(id),
  side text not null check (side in ('buy', 'sell')),
  price bigint not null check (price > 0),
  qty bigint not null check (qty > 0),
  filled bigint not null default 0,
  escrow bigint not null default 0,
  status text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  created_at timestamptz not null default now()
);
create index share_orders_book_idx on game.share_orders (company_id, side, price, created_at) where status = 'open';

create table game.share_trades (
  id bigint generated always as identity primary key,
  company_id uuid not null references game.companies(owner_id),
  price bigint not null,
  qty bigint not null,
  buyer_id uuid not null references game.players(id),
  seller_id uuid not null references game.players(id),
  at timestamptz not null default now()
);

create function public.ipo(p_name text, p_price bigint, p_shares bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_total bigint := game.cfg('share_count')::bigint;
  v_symbol text;
begin
  perform game.require_tier(p, 6);
  if exists (select 1 from game.companies where owner_id = p.id and ipo_at is not null) then perform game.fail('Your company is already public.'); end if;
  if p_price is null or p_price < 1000 then perform game.fail('Set a share price of at least $1.'); end if;
  if p_shares is null or p_shares < 1000 or p_shares > v_total * game.cfg('ipo_max_pct') / 100 then
    perform game.fail(format('Offer between 1,000 and %s shares (%s%% of the company).', v_total * game.cfg('ipo_max_pct') / 100, game.cfg('ipo_max_pct')));
  end if;
  v_symbol := 'CC' || p.player_no;
  insert into game.companies (owner_id, symbol, name, ipo_at, ipo_price, last_price)
  values (p.id, v_symbol, game.clean_name(p_name, p.display_name || ' Holdings'), now(), p_price, p_price)
  on conflict (owner_id) do update set ipo_at = now(), ipo_price = p_price, last_price = p_price, name = excluded.name;
  insert into game.shareholdings (company_id, holder_id, qty) values (p.id, p.id, v_total - p_shares)
  on conflict (company_id, holder_id) do update set qty = v_total - p_shares;
  -- The offered shares sit in a sell order from the owner.
  insert into game.share_orders (company_id, player_id, side, price, qty) values (p.id, p.id, 'sell', p_price, p_shares);
  perform game.award(p.id, 'public_company');
  return jsonb_build_object('symbol', v_symbol, 'offered', p_shares, 'price', p_price);
end $$;

create function public.place_share_order(p_symbol text, p_side text, p_qty bigint, p_price bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.companies;
  o game.share_orders;
  remaining bigint := p_qty;
  take bigint;
  v_val bigint;
  v_fee bigint;
  v_order bigint;
  v_held bigint;
begin
  perform game.require_tier(p, 2);
  perform game.rate_limit(p.id::text, 'share_order', 20, 30);
  select * into c from game.companies where symbol = upper(p_symbol) and ipo_at is not null for update;
  if not found then perform game.fail('No public company with that symbol.'); end if;
  if p_side not in ('buy', 'sell') then perform game.fail('Choose buy or sell.'); end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then perform game.fail('Enter a quantity.'); end if;
  if p_price is null or p_price <= 0 or p_price > 100000000000 then perform game.fail('Enter a price.'); end if;
  if p_side = 'sell' then
    update game.shareholdings set qty = qty - p_qty where company_id = c.owner_id and holder_id = p.id and qty >= p_qty;
    if not found then perform game.fail('You don''t have that many shares.'); end if;
  end if;
  loop
    exit when remaining <= 0;
    if p_side = 'buy' then
      select * into o from game.share_orders where company_id = c.owner_id and side = 'sell' and status = 'open' and player_id <> p.id and price <= p_price
       order by price, created_at limit 1 for update;
    else
      select * into o from game.share_orders where company_id = c.owner_id and side = 'buy' and status = 'open' and player_id <> p.id and price >= p_price
       order by price desc, created_at limit 1 for update;
    end if;
    exit when not found;
    take := least(remaining, o.qty - o.filled);
    v_val := take * o.price;
    v_fee := round(v_val * game.cfg('trade_fee_pct') / 100.0);
    if p_side = 'buy' then
      perform game.money(p.id, -v_val, 'shares_buy', format('Bought %s %s shares', take, c.symbol), jsonb_build_object('symbol', c.symbol));
      perform game.money(o.player_id, v_val, 'shares_sell', format('Sold %s %s shares', take, c.symbol), jsonb_build_object('symbol', c.symbol));
      perform game.money(o.player_id, -v_fee, 'fee', format('1%% fee on %s shares', c.symbol));
      insert into game.shareholdings (company_id, holder_id, qty) values (c.owner_id, p.id, take)
      on conflict (company_id, holder_id) do update set qty = game.shareholdings.qty + take;
      insert into game.share_trades (company_id, price, qty, buyer_id, seller_id) values (c.owner_id, o.price, take, p.id, o.player_id);
      update game.share_orders set filled = filled + take, status = case when filled + take >= qty then 'filled' else 'open' end where id = o.id;
    else
      perform game.money(o.player_id, v_val, 'escrow_return', 'Share buy order filled', jsonb_build_object('order', o.id));
      perform game.money(o.player_id, -v_val, 'shares_buy', format('Bought %s %s shares', take, c.symbol), jsonb_build_object('symbol', c.symbol));
      perform game.money(p.id, v_val, 'shares_sell', format('Sold %s %s shares', take, c.symbol), jsonb_build_object('symbol', c.symbol));
      perform game.money(p.id, -v_fee, 'fee', format('1%% fee on %s shares', c.symbol));
      insert into game.shareholdings (company_id, holder_id, qty) values (c.owner_id, o.player_id, take)
      on conflict (company_id, holder_id) do update set qty = game.shareholdings.qty + take;
      insert into game.share_trades (company_id, price, qty, buyer_id, seller_id) values (c.owner_id, o.price, take, o.player_id, p.id);
      update game.share_orders set filled = filled + take, escrow = escrow - v_val, status = case when filled + take >= qty then 'filled' else 'open' end where id = o.id;
    end if;
    update game.companies set last_price = o.price where owner_id = c.owner_id;
    perform game.notify(o.player_id, 'shares', format('Share order filled: %s %s', take, c.symbol), null, jsonb_build_object('symbol', c.symbol));
    remaining := remaining - take;
  end loop;
  if remaining > 0 then
    if p_side = 'buy' then
      perform game.money(p.id, -(remaining * p_price), 'escrow', format('Share buy order: %s %s', remaining, c.symbol));
      insert into game.share_orders (company_id, player_id, side, price, qty, filled, escrow)
      values (c.owner_id, p.id, 'buy', p_price, p_qty, p_qty - remaining, remaining * p_price) returning id into v_order;
    else
      insert into game.share_orders (company_id, player_id, side, price, qty, filled)
      values (c.owner_id, p.id, 'sell', p_price, p_qty, p_qty - remaining) returning id into v_order;
    end if;
  end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('filled', p_qty - remaining, 'resting', remaining, 'order_id', v_order);
end $$;

create function public.cancel_share_order(p_order bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  o game.share_orders;
begin
  perform 1 from game.companies c join game.share_orders so on so.company_id = c.owner_id where so.id = p_order for update of c;
  select * into o from game.share_orders where id = p_order and player_id = p.id and status = 'open' for update;
  if not found then perform game.fail('Order not found.'); end if;
  if o.side = 'buy' and o.escrow > 0 then
    perform game.money(p.id, o.escrow, 'escrow_return', 'Cancelled share order');
  elsif o.side = 'sell' then
    update game.shareholdings set qty = qty + (o.qty - o.filled) where company_id = o.company_id and holder_id = p.id;
  end if;
  update game.share_orders set status = 'cancelled', escrow = 0 where id = o.id;
  return jsonb_build_object('ok', true);
end $$;

-- Owner pays a dividend per share to every other shareholder.
create function public.pay_dividend(p_per_share bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.companies;
  h record;
  v_total bigint;
begin
  select * into c from game.companies where owner_id = p.id and ipo_at is not null for update;
  if not found then perform game.fail('Your company isn''t public.'); end if;
  if p_per_share is null or p_per_share < 1 then perform game.fail('Enter a dividend per share.'); end if;
  select coalesce(sum(qty), 0) * p_per_share into v_total from game.shareholdings where company_id = p.id and holder_id <> p.id and qty > 0;
  if v_total = 0 then perform game.fail('Nobody else holds shares yet.'); end if;
  perform game.money(p.id, -v_total, 'dividend', format('Dividend of %s a share', game.fmt(p_per_share)), jsonb_build_object('symbol', c.symbol));
  for h in select * from game.shareholdings where company_id = p.id and holder_id <> p.id and qty > 0 loop
    perform game.money(h.holder_id, h.qty * p_per_share, 'dividend', format('Dividend from %s', c.symbol), jsonb_build_object('symbol', c.symbol));
    perform game.notify(h.holder_id, 'shares', format('Dividend from %s: %s', c.symbol, game.fmt(h.qty * p_per_share)));
  end loop;
  update game.companies set dividends_paid = dividends_paid + v_total where owner_id = p.id;
  return jsonb_build_object('paid', v_total);
end $$;

create function public.share_market() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
begin
  return jsonb_build_object(
    'companies', (select coalesce(jsonb_agg(jsonb_build_object('symbol', c.symbol, 'name', c.name, 'owner_name', pl.display_name, 'owner_no', pl.player_no,
        'last_price', c.last_price, 'ipo_price', c.ipo_price, 'ipo_at', c.ipo_at, 'dividends_paid', c.dividends_paid,
        'market_cap', c.last_price * game.cfg('share_count'),
        'best_bid', (select max(price) from game.share_orders o where o.company_id = c.owner_id and o.side = 'buy' and o.status = 'open'),
        'best_ask', (select min(price) from game.share_orders o where o.company_id = c.owner_id and o.side = 'sell' and o.status = 'open'),
        'my_shares', (select qty from game.shareholdings h where h.company_id = c.owner_id and h.holder_id = v_uid),
        'owner_net_worth', pl.net_worth) order by c.last_price * 1 desc), '[]'::jsonb)
      from game.companies c join game.players pl on pl.id = c.owner_id where c.ipo_at is not null),
    'my_orders', (select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object('symbol', c.symbol)), '[]'::jsonb)
                    from game.share_orders o join game.companies c on c.owner_id = o.company_id where o.player_id = v_uid and o.status = 'open')
  );
end $$;

-- ---------------------------------------------------------------------------
-- Loan repayments, every tick.
-- ---------------------------------------------------------------------------
create function game.finance_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  l game.loans;
  v_days float8;
  v_interest bigint;
  v_instal bigint;
  v_due bigint;
begin
  for l in select * from game.loans where status = 'active' and last_charge_at < now() - interval '50 seconds' for update skip locked loop
    v_days := least(1, extract(epoch from now() - l.last_charge_at) / 86400.0);
    v_interest := round(l.outstanding * l.rate_daily / 100.0 * v_days);
    v_instal := least(l.outstanding, ceil(l.principal::numeric / l.term_days * v_days)::bigint);
    v_due := v_interest + v_instal + l.missed;
    if v_interest > 0 then
      update game.loans set outstanding = outstanding + v_interest where id = l.id;
      l.outstanding := l.outstanding + v_interest;
    end if;
    if v_due > 0 and game.try_money(l.borrower_id, -least(v_due, l.outstanding),
        case when l.bank_id is null then 'npc_loan_repay' else 'loan_repay' end, 'Loan repayments', jsonb_build_object('loan', l.id), true) then
      perform game.pay_lender(l, least(v_due, l.outstanding), v_interest);
      update game.loans set outstanding = outstanding - least(v_due, l.outstanding), missed = 0, missed_since = null, last_charge_at = now(),
             status = case when outstanding - least(v_due, l.outstanding) <= 0 then 'repaid' else 'active' end,
             closed_at = case when outstanding - least(v_due, l.outstanding) <= 0 then now() end
       where id = l.id;
    else
      update game.loans set missed = missed + v_instal + v_interest, missed_since = coalesce(missed_since, now()), last_charge_at = now() where id = l.id;
      if coalesce(l.missed_since, now()) < now() - make_interval(days => game.cfg('default_days')::int) then
        update game.loans set status = 'defaulted', closed_at = now() where id = l.id;
        update game.players set credit_blocked_until = now() + interval '30 days' where id = l.borrower_id;
        perform game.notify(l.borrower_id, 'bank', 'You defaulted on a loan', 'You can''t borrow again for 30 days.', jsonb_build_object('loan', l.id));
        if l.lender_id is not null then
          perform game.notify(l.lender_id, 'bank', 'A borrower defaulted', format('%s of the loan won''t be repaid.', game.fmt(l.outstanding)),
            jsonb_build_object('loan', l.id));
        end if;
      end if;
    end if;
  end loop;
  perform game.events_tick();
end $$;

-- ---------------------------------------------------------------------------
-- World events
-- ---------------------------------------------------------------------------
create table game.events (
  id bigint generated always as identity primary key,
  city_id text references game.cities(id),
  kind text not null,
  title text not null,
  body text not null,
  traffic_mult numeric not null default 1,
  category_mult jsonb not null default '{}'::jsonb,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by uuid references game.players(id),
  announced boolean not null default false
);
create index events_active_idx on game.events (ends_at, starts_at);

create table game.event_templates (
  kind text primary key,
  title text not null,
  body text not null,
  traffic_mult numeric not null default 1,
  category_mult jsonb not null default '{}'::jsonb,
  hours int not null,
  weight int not null default 1
);
insert into game.event_templates (kind, title, body, traffic_mult, category_mult, hours, weight) values
  ('festival', 'Street festival in {city}', 'Crowds pour into the streets: foot traffic is up 40% for the weekend.', 1.4, '{}', 48, 3),
  ('heatwave', 'Heatwave in {city}', 'Everyone wants something quick and cold: street food up 35%, restaurants down 15%.', 1, '{"street":1.35,"restaurant":0.85}', 24, 3),
  ('rain', 'Rainy week in {city}', 'People duck indoors: cafés up 30%, street food down 30%.', 1, '{"cafe":1.3,"street":0.7}', 36, 3),
  ('strike', 'Transit strike in {city}', 'Fewer commuters: foot traffic is down 25% for a day.', 0.75, '{}', 24, 2),
  ('food_week', 'Restaurant week in {city}', 'Diners are out in force: restaurants up 40%.', 1, '{"restaurant":1.4}', 72, 2),
  ('sale_season', 'Big sale weekend in {city}', 'Shoppers everywhere: grocery, furniture and electronics stores up 50%.', 1, '{"grocery":1.5,"furniture":1.5,"electronics":1.5}', 48, 2),
  ('marathon', 'City marathon in {city}', 'Runners and spectators line the streets: foot traffic up 25%, street food up 30%.', 1.25, '{"street":1.3}', 12, 1);

create function game.event_mult(p_city text, p_category text) returns numeric
language sql stable set search_path = game, pg_temp as $$
  select coalesce(exp(sum(ln(e.traffic_mult * coalesce((e.category_mult ->> p_category)::numeric, 1)))), 1)
  from game.events e
  where (e.city_id = p_city or e.city_id is null) and now() between e.starts_at and e.ends_at
$$;

-- Starts a random event in a quiet city every few hours, and announces new ones.
create function game.events_tick() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  c record;
  t game.event_templates;
  e game.events;
begin
  if random() < 0.004 then
    select * into c from game.cities ci where ci.open
       and not exists (select 1 from game.events ev where ev.city_id = ci.id and ev.ends_at > now())
     order by random() limit 1;
    if found then
      select * into t from game.event_templates order by random() * weight desc limit 1;
      insert into game.events (city_id, kind, title, body, traffic_mult, category_mult, starts_at, ends_at)
      values (c.id, t.kind, replace(t.title, '{city}', c.name), t.body, t.traffic_mult, t.category_mult,
              now() + interval '30 minutes', now() + interval '30 minutes' + make_interval(hours => t.hours));
    end if;
  end if;
  for e in select * from game.events where not announced and starts_at < now() + interval '1 hour' for update skip locked loop
    update game.events set announced = true where id = e.id;
    perform game.push('world', 'event', jsonb_build_object('title', e.title, 'body', e.body, 'city_id', e.city_id, 'starts_at', e.starts_at));
    if to_regclass('game.chat_messages') is not null then
      -- Announced in the city's chat as a system notice.
      null;
    end if;
  end loop;
end $$;

create function public.world_events() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'city_id', city_id, 'kind', kind, 'title', title, 'body', body,
    'starts_at', starts_at, 'ends_at', ends_at, 'active', now() between starts_at and ends_at) order by starts_at), '[]'::jsonb)
  from game.events where ends_at > now() and starts_at < now() + interval '1 day'
$$;

-- Staff: schedule an event by hand.
create function public.admin_create_event(p_city text, p_kind text, p_starts_in_minutes int default 0) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t game.event_templates;
  c game.cities;
  v_id bigint;
begin
  perform game.require_staff(p, true);
  select * into t from game.event_templates where kind = p_kind;
  if not found then perform game.fail('Unknown event kind.'); end if;
  select * into c from game.cities where id = p_city;
  insert into game.events (city_id, kind, title, body, traffic_mult, category_mult, starts_at, ends_at, created_by)
  values (c.id, t.kind, replace(t.title, '{city}', coalesce(c.name, 'every city')), t.body, t.traffic_mult, t.category_mult,
          now() + make_interval(mins => coalesce(p_starts_in_minutes, 0)),
          now() + make_interval(mins => coalesce(p_starts_in_minutes, 0)) + make_interval(hours => t.hours), p.id)
  returning id into v_id;
  insert into game.staff_actions (staff_id, action, reason, ref) values (p.id, 'event', t.title, jsonb_build_object('event', v_id));
  return jsonb_build_object('event_id', v_id);
end $$;
