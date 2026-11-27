-- The slowdown's real cause: a number that kept growing digits.
--
-- A country's stability and the relation score between two countries were
-- stored as numerics without a fixed precision. Stability moves towards its
-- target by (target - stability) x (hours since last time) / 2 every tick;
-- multiplying numerics adds their decimal places together, so every tick
-- made the number longer. On the live world every country's stability had
-- reached 16,383 decimal places (the most a numeric can hold), so each tick
-- did arithmetic on 16,000-digit numbers for all 175 countries, and every
-- country update wrote 8 KB. The server's CPU was spent on that, so the
-- minute job, and with it every button, slowed to a crawl.
--
-- Fixed precision (4 decimal places) from now on: the numbers stay short and
-- the arithmetic cheap. Relation scores (multiplied by 0.97 every ten
-- minutes) get the same treatment.

alter table game.nations alter column stability type numeric(9, 4) using round(stability, 4);
alter table game.relations alter column score type numeric(9, 4) using round(score, 4);

-- Background jobs don't wait for each commit to reach the disk (a crash
-- could lose the last fraction of a second of ticking, which the next tick
-- catches up from elapsed time; nothing can be half-applied).
create or replace procedure game.minute_run()
language plpgsql as $$
begin
  perform set_config('synchronous_commit', 'off', false);
  call game.tick();
  call game.world_run();
  call game.renown_run();
end $$;
