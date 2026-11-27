-- Lighter AI, so a small server has room to spare.
--
-- The AI governments' turns are the biggest share of the minute job, and
-- they run whether or not anyone is playing. On the live server (a small,
-- burstable instance) the job used most of what the CPU can sustain. Now:
--   * AI governments think half as often (every 8 to 28 minutes, by skill);
--   * at most 10 of them think in any one minute (was 25);
--   * AI economies are settled every 10 minutes (was 4); they're worked out
--     from the time since they last ran, so the totals are the same.
-- All three are settings in game.config, so they can be tuned on the live
-- game without a release.

insert into game.config (key, value, note) values
  ('ai_think_mult', 2, 'AI governments think this many times less often than the base 4-14 minutes'),
  ('ai_think_per_minute', 10, 'At most this many AI governments think in one minute'),
  ('ai_econ_minutes', 10, 'AI economies are settled this often, in minutes (totals are the same)')
on conflict (key) do nothing;

create or replace function game.world_ai_one(p_id text) returns void
language plpgsql set search_path = game, pg_temp as $$
begin
  begin
    perform game.ai_think(p_id);
  exception when others then
    raise warning 'ai % failed: %', p_id, sqlerrm;
  end;
  update game.nations
     set next_think_at = now() + make_interval(secs => ((60 * (4 + 2 * (6 - ai_skill)) + floor(random() * 120))
                                                        * greatest(0.5, coalesce(game.cfg('ai_think_mult'), 1)))::int)
   where id = p_id;
end $$;

create or replace procedure game.world_run()
language plpgsql as $$
declare
  v_ids text[];
  v_id text;
  v_stage text;
begin
  if not pg_try_advisory_lock(434343) then return; end if;
  -- Player-led countries every minute (their leader's income keeps
  -- flowing); AI countries every few minutes, a slice at a time (their
  -- economy is worked out from the time since it last ran, so totals are
  -- the same, for a fifth of the work).
  select coalesce(array_agg(id order by id), '{}') into v_ids from game.nations
   where status = 'active' and (leader_id is not null
         or last_econ_at < now() - make_interval(mins => coalesce(game.cfg('ai_econ_minutes'), 4)::int));
  commit;
  foreach v_id in array v_ids loop
    perform game.world_economy_one(v_id);
    commit;
  end loop;
  foreach v_stage in array array['training', 'construction', 'arrivals', 'wars', 'revolts', 'diplomacy'] loop
    begin
      perform game.world_stage(v_stage);
    exception when others then
      raise warning 'world stage % failed: %', v_stage, sqlerrm;
    end;
    commit;
  end loop;
  select coalesce(array_agg(id order by next_think_at), '{}') into v_ids from (
    select id, next_think_at from game.nations where leader_id is null and status = 'active' and next_think_at <= now()
     order by next_think_at limit coalesce(game.cfg('ai_think_per_minute'), 25)::int) x;
  commit;
  foreach v_id in array v_ids loop
    perform game.world_ai_one(v_id);
    commit;
  end loop;
  foreach v_stage in array array['scores', 'away'] loop
    begin
      perform game.world_stage(v_stage);
    exception when others then
      raise warning 'world stage % failed: %', v_stage, sqlerrm;
    end;
    commit;
  end loop;
  perform pg_advisory_unlock(434343);
end $$;
