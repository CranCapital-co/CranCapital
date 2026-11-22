-- Numbers behind the Empire dashboard and the HUD: a daily net-worth
-- snapshot for each player (refreshed every hour, so today's point keeps
-- up), the history reader, and the last hour's sales income.

create table game.net_worth_daily (
  player_id uuid not null references game.players(id) on delete cascade,
  day date not null,
  net_worth bigint not null,
  cash bigint not null,
  primary key (player_id, day)
);
alter table game.net_worth_daily enable row level security;
revoke all on game.net_worth_daily from public, anon, authenticated;

create function game.snapshot_net_worth() returns void
language sql set search_path = game, pg_temp as $$
  insert into game.net_worth_daily (player_id, day, net_worth, cash)
  select id, (now() at time zone 'utc')::date, net_worth, cash from game.players where status <> 'deleted'
  on conflict (player_id, day) do update set net_worth = excluded.net_worth, cash = excluded.cash;
  delete from game.net_worth_daily where day < (now() at time zone 'utc')::date - 120;
$$;

-- Your net worth for the last p_days days (at most 90), oldest first, with
-- today's value live.
create function public.net_worth_history(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_days int := greatest(2, least(coalesce(p_days, 7), 90));
  v_today date := (now() at time zone 'utc')::date;
begin
  return coalesce((select jsonb_agg(jsonb_build_object('day', day, 'net_worth', net_worth) order by day)
    from (
      select day, net_worth from game.net_worth_daily
       where player_id = p.id and day > v_today - v_days and day < v_today
      union all
      select v_today, p.net_worth
    ) x), '[]'::jsonb);
end $$;

-- Sales income over the last hour, for the HUD's "+$1,240 an hour".
create function public.my_income() returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object('per_hour', coalesce((
    select sum(amount) from game.ledger
     where player_id = p.id and kind = 'sales' and at > now() - interval '1 hour'), 0));
end $$;

revoke all on function public.net_worth_history(int), public.my_income() from public, anon, authenticated;
grant execute on function public.net_worth_history(int), public.my_income() to authenticated, service_role;
revoke all on function game.snapshot_net_worth() from public, anon, authenticated;

select game.snapshot_net_worth();

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'crancapital-worth';
  perform cron.schedule('crancapital-worth', '7 * * * *', 'select game.snapshot_net_worth()');
end $$;
