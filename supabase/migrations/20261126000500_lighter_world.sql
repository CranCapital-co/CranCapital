-- A lighter world tick: AI countries' economies are settled every few
-- minutes instead of every minute (the same totals, from elapsed time),
-- which takes most of the remaining work out of the once-a-minute job.
-- Player-led countries still settle every minute.
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
   where status = 'active' and (leader_id is not null or last_econ_at < now() - interval '4 minutes');
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
     order by next_think_at limit 25) x;
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
