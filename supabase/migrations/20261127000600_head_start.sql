-- A head start for every new player, growing as the world does.
--
-- New players joined with $10,000 and level 1 into a world where others
-- are worth millions and dozens of levels up. Now each new player also
-- gets a head start sized from the players active in the last week (who
-- have played for at least a day):
--   * cash: a fifth of their median net worth ($50,000 to $2,000,000);
--   * Renown levels: two fifths of their median level (5 to 30), with the
--     perk points and unlocks those levels bring;
--   * gold crates: 2, plus one per 10 levels.
-- What was given is recorded, and the game shows it once, explaining what
-- each part does.

create table if not exists game.head_starts (
  player_id uuid primary key references game.players(id) on delete cascade,
  granted jsonb not null,
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
alter table game.head_starts enable row level security;
revoke all on game.head_starts from public, anon, authenticated;

insert into game.ledger_kinds (kind, label, flow) values ('head_start', 'Head start', 'world_in')
on conflict (kind) do nothing;

insert into game.config (key, value, note) values ('head_start', 1, 'Give new players a head start (1) or not (0)')
on conflict (key) do nothing;

-- The size of the head start today.
create or replace function game.head_start_size() returns jsonb
language sql stable as $$
  with active as (
    select p.net_worth, coalesce(r.level, 1) lvl from game.players p left join game.renown r on r.player_id = p.id
     where p.status = 'active' and p.last_seen_at > now() - interval '7 days' and p.created_at < now() - interval '1 day'
  ), m as (
    select coalesce(percentile_cont(0.5) within group (order by net_worth), 0) worth,
           coalesce(percentile_cont(0.5) within group (order by lvl), 1) lvl, count(*) n from active
  )
  select jsonb_build_object(
    'cash', (greatest(50000000, least(2000000000, round(m.worth * 0.2))))::bigint,
    'level', greatest(5, least(30, floor(m.lvl * 0.4)))::int,
    'crates', (2 + floor(greatest(5, least(30, floor(m.lvl * 0.4))) / 10))::int,
    'world_worth', round(m.worth)::bigint,
    'world_level', round(m.lvl)::int,
    'players', m.n)
  from m
$$;

create or replace function game.give_head_start(p_player uuid) returns jsonb
language plpgsql set search_path = game, pg_temp as $$
declare
  s jsonb := game.head_start_size();
  v_lvl int := (s ->> 'level')::int;
  v_n bigint;
  v_from int;
begin
  if exists (select 1 from game.head_starts where player_id = p_player) or coalesce(game.cfg('head_start'), 1) <= 0 then return null; end if;
  perform game.money(p_player, (s ->> 'cash')::bigint, 'head_start', 'Head start');
  perform game.renown_row(p_player);
  select level into v_from from game.renown where player_id = p_player;
  v_n := (select total from game.level_xp where level = v_lvl) - (select xp from game.renown where player_id = p_player);
  while v_n > 0 loop
    perform game.grant_xp(p_player, least(v_n, 2000000000)::int, 'Head start');
    v_n := (select total from game.level_xp where level = v_lvl) - (select xp from game.renown where player_id = p_player);
  end loop;
  perform game.add_crate(p_player, 'gold', (s ->> 'crates')::int);
  s := s || jsonb_build_object(
    'perk_points', (select perk_points from game.renown where player_id = p_player),
    'level', (select level from game.renown where player_id = p_player),
    'unlocks', (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'body', body, 'icon', icon) order by level, key), '[]'::jsonb)
                  from game.renown_unlocks where level > v_from and level <= (select level from game.renown where player_id = p_player)));
  insert into game.head_starts (player_id, granted) values (p_player, s);
  return s;
end $$;

-- Shown once: what you were given.
create or replace function public.my_head_start() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select granted from game.head_starts where player_id = game.uid() and seen_at is null
$$;

create or replace function public.head_start_seen() returns void
language sql security definer set search_path = game, pg_temp as $$
  update game.head_starts set seen_at = now() where player_id = game.uid() and seen_at is null
$$;

revoke all on function public.my_head_start(), public.head_start_seen() from public, anon;
grant execute on function public.my_head_start(), public.head_start_seen() to authenticated, service_role;

create or replace function public.create_player(p_name text, p_age_ok boolean, p_referral text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v_name text;
  v_ref uuid;
  p game.players;
  v_code text;
begin
  if v_uid is null then perform game.fail('Please sign in first.'); end if;
  if exists (select 1 from game.players where id = v_uid) then perform game.fail('You already have a player.'); end if;
  if not coalesce(p_age_ok, false) then perform game.fail('You must be 13 or over to play CranCapital.'); end if;
  perform game.rate_limit(v_uid::text, 'create_player', 5, 1);
  v_name := game.check_display_name(p_name);
  if exists (select 1 from game.players where lower(display_name) = lower(v_name) and status <> 'deleted') then
    perform game.fail('That name is taken. Try another.');
  end if;
  if p_referral is not null and btrim(p_referral) <> '' then
    select id into v_ref from game.players where referral_code = upper(btrim(p_referral)) and status = 'active';
  end if;
  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists (select 1 from game.players where referral_code = v_code);
  end loop;
  insert into game.players (id, display_name, age_ok, referral_code, referred_by, last_day, days_played, loyalty_points)
  values (v_uid, v_name, true, v_code, v_ref, (now() at time zone 'utc')::date, 1, game.cfg('loyalty_per_day')::int)
  returning * into p;
  perform game.money(p.id, game.cfg('start_cash')::bigint, 'start_grant', 'Welcome to CranCapital');
  if p.created_at < coalesce((select min(created_at) from game.players), now()) + interval '30 days' then
    perform game.award(p.id, 'founder');
  end if;
  if v_ref is not null then
    perform game.notify(v_ref, 'referral', 'Someone joined with your invite', format('%s joined CranCapital using your link.', v_name));
  end if;
  perform game.give_head_start(p.id);
  perform game.refresh_worth(p.id);
  select * into p from game.players where id = v_uid;
  return game.player_json(p);
end $$;
