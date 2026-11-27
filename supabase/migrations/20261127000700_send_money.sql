-- Send money to any country.
--
-- To an AI country: it goes into its treasury and it thanks you in your
-- Talk thread. To a player-led country: it goes to its leader.
-- Goodwill between countries grows with the size of the gift (compared
-- with what that country earns in an hour), and personality matters, but
-- relations bought this way share the chat's cap of +25 a day per country,
-- so money can't farm relations.
-- Between players, limits stop new accounts feeding a main one: an account
-- must be 3 days old, and you can send up to a quarter of your net worth
-- (at least $10,000) a day to player-led countries.

insert into game.ledger_kinds (kind, label, flow) values ('gift', 'Money sent between players', 'transfer')
on conflict (kind) do nothing;

create table if not exists game.nation_gifts (
  id bigint generated always as identity primary key,
  from_player uuid not null references game.players(id) on delete cascade,
  from_nation text,
  to_nation text not null references game.nations(id) on delete cascade,
  to_player uuid,
  amount bigint not null,
  rel_delta numeric not null default 0,
  at timestamptz not null default now()
);
create index if not exists nation_gifts_from_idx on game.nation_gifts (from_player, at desc);
alter table game.nation_gifts enable row level security;
revoke all on game.nation_gifts from public, anon, authenticated;

create or replace function public.send_money(p_nation text, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_me text := game.player_nation(p.id);
  n game.nations;
  v_cap bigint;
  v_sent bigint;
  v_delta numeric := 0;
  v_gained numeric;
  v_reply text;
begin
  perform game.rate_limit(p.id::text, 'send_money', 10, 10);
  select * into n from game.nations where id = p_nation;
  if not found then perform game.fail('No such country.'); end if;
  if n.status <> 'active' then perform game.fail(n.name || ' has fallen.'); end if;
  if v_me = n.id then perform game.fail('That''s your own country.'); end if;
  if p_amount is null or p_amount < 1000000 then perform game.fail('Send at least $1,000.'); end if;
  if p_amount > p.cash then perform game.fail(format('You only have %s.', game.fmt(p.cash))); end if;

  if n.leader_id is not null then
    if p.created_at > now() - interval '3 days' then
      perform game.fail('You can send money to other players'' countries once your account is 3 days old.');
    end if;
    v_cap := greatest(10000000, (p.net_worth / 4)::bigint);
    select coalesce(sum(amount), 0) into v_sent from game.nation_gifts
     where from_player = p.id and to_player is not null and at > now() - interval '1 day';
    if v_sent + p_amount > v_cap then
      perform game.fail(format('You can send up to %s a day to other players'' countries (a quarter of your net worth): %s left today.',
        game.fmt(v_cap), game.fmt(greatest(0, v_cap - v_sent))));
    end if;
    perform game.money(p.id, -p_amount, 'gift', 'To ' || n.name, jsonb_build_object('nation', n.id));
    perform game.money(n.leader_id, p_amount, 'gift', 'From ' || p.display_name, jsonb_build_object('from_player', p.id, 'nation', v_me));
    perform game.notify(n.leader_id, 'gift', format('%s sent you %s', p.display_name, game.fmt(p_amount)),
      case when v_me is not null then 'From ' || game.nation_name(v_me) || '.' end, jsonb_build_object('nation', v_me));
    perform game.refresh_worth(n.leader_id);
  else
    perform game.money(p.id, -p_amount, 'diplomacy_payment', 'Gift to ' || n.name, jsonb_build_object('nation', n.id));
    update game.nations set treasury = treasury + p_amount where id = n.id;
  end if;

  -- Goodwill between countries, capped with chat at +25 a day per country.
  if v_me is not null then
    v_delta := least(15, 6.0 * p_amount / greatest(n.income_h, 1000000)
      * case n.personality when 'mercantile' then 1.5 when 'diplomatic' then 1.2 when 'aggressive' then 0.6 when 'expansionist' then 0.8 else 1 end);
    select coalesce(sum(rel_delta), 0) into v_gained from game.diplo_chat
     where player_id = p.id and nation_id = n.id and not from_player and intent = 'answer' and rel_delta > 0 and at > now() - interval '1 day';
    v_delta := round(greatest(0, least(v_delta, 25 - v_gained)), 1);
    if v_delta > 0 then perform game.rel_add(v_me, n.id, v_delta); end if;
  end if;
  insert into game.nation_gifts (from_player, from_nation, to_nation, to_player, amount, rel_delta)
  values (p.id, v_me, n.id, n.leader_id, p_amount, v_delta);

  -- An AI government says thank you, in its own voice, in your Talk thread.
  if n.leader_id is null then
    v_reply := case
      when v_delta >= 5 then game.pick(array[
        'A generous gift. %s will not forget this kindness.',
        'Your generosity is noted, and it is welcome. %s counts you as a friend.',
        'Thank you. Gifts like this are how real friendships between nations begin.'])
      when v_delta > 0 then game.pick(array[
        'Thank you for the gift. Every little helps.',
        'Received, with thanks.',
        'A kind gesture. We appreciate it.'])
      when v_me is null then game.pick(array['Thank you for your gift.', 'Received, with thanks.'])
      else game.pick(array[
        'Thank you. Our goodwill, though, has had its fill for today.',
        'Received. We are grateful, but our opinion of you will not move further today.']) end;
    v_reply := replace(v_reply, '%s', n.name);
    insert into game.diplo_chat (player_id, nation_id, from_player, body, intent, mood, rel_delta)
    values (p.id, n.id, true, format('Sent you %s.', game.fmt(p_amount)), 'gift_sent', null, 0),
           (p.id, n.id, false, v_reply, 'answer', null, v_delta);
  end if;
  perform game.refresh_worth(p.id);
  return jsonb_build_object('ok', true, 'amount', p_amount, 'rel_delta', v_delta, 'reply', v_reply,
    'relation', case when v_me is null then null else round(game.rel(v_me, n.id)) end);
end $$;

revoke all on function public.send_money(text, bigint) from public, anon;
grant execute on function public.send_money(text, bigint) to authenticated, service_role;
