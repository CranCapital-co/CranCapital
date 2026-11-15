-- CranCapital social: filters, chat, friends, blocks, boards, Discord
-- directory, reports and moderation, profiles and cosmetics, leaderboards,
-- referrals, account tools.
--
-- Moderation rules: automatic filters always tell the player what they did
-- (a link is refused with a reason; a slur is masked with a notice). Staff
-- decisions are made by people and always carry a reason the player sees.
-- Nothing is silently hidden or shadow-banned.

-- ---------------------------------------------------------------------------
-- Filters
-- ---------------------------------------------------------------------------
create table game.filter_words (
  word text primary key
);

-- Letters a filter word may be disguised with.
create function game.filter_pattern(p_word text) returns text
language sql immutable set search_path = game, pg_temp as $$
  select '(^|[^[:alnum:]])(' || string_agg(
    case ch
      when 'a' then '[a4@]+' when 'e' then '[e3]+' when 'i' then '[i1!|l]+' when 'o' then '[o0]+'
      when 's' then '[s5$]+' when 't' then '[t7]+' when 'g' then '[g9]+' when 'b' then '[b8]+'
      else regexp_replace(ch, '([^[:alnum:]])', '\\\1', 'g') || '+' end, '[^[:alnum:]]*' order by n) || ')(?=$|[^[:alnum:]])'
  from regexp_split_to_table(lower(p_word), '') with ordinality t(ch, n)
$$;

create function game.has_link(p_text text) returns boolean
language sql immutable set search_path = game, pg_temp as $$
  select coalesce(p_text, '') ~* '(https?:|www\.|[a-z0-9-]+\s*(\.|\[\s*dot\s*\]|\(\s*dot\s*\))\s*(com|net|org|io|gg|co|uk|me|tv|app|dev|xyz|info|biz|ru|de|fr|jp|sg|us|ly|to|be|link|site|online|shop|store|live|club|ai|so|fm|cc)([^[:alpha:]]|$)|discord\s*\.\s*gg|bit\s*\.\s*ly|t\.me/)'
$$;

-- Masks filter words; returns the masked text.
create function game.mask_text(p_text text) returns text
language plpgsql stable set search_path = game, pg_temp as $$
declare
  v text := p_text;
  w record;
begin
  for w in select word from game.filter_words loop
    v := regexp_replace(v, game.filter_pattern(w.word), '\1' || repeat('*', length(w.word)), 'gi');
  end loop;
  return v;
end $$;

-- Names: no links, no filter words. Returns the name unchanged when fine.
create function game.check_name(p_name text) returns text
language plpgsql stable set search_path = game, pg_temp as $$
begin
  if game.has_link(p_name) then
    perform game.fail('Names can''t contain links.');
  end if;
  if game.mask_text(p_name) <> p_name then
    perform game.fail('That name contains a word that isn''t allowed. Please choose another.');
  end if;
  return p_name;
end $$;

-- Free text (chat, posts): links refused with a reason, slurs masked.
create function game.check_text(p_text text, p_max int, out body text, out masked boolean)
language plpgsql stable set search_path = game, pg_temp as $$
begin
  body := btrim(coalesce(p_text, ''));
  if body = '' then perform game.fail('Write something first.'); end if;
  if length(body) > p_max then perform game.fail(format('That''s too long: keep it under %s characters.', p_max)); end if;
  if game.has_link(body) then
    perform game.fail('Links aren''t allowed in CranCapital, so this wasn''t sent. Share Discord servers through the Discord directory instead.');
  end if;
  masked := game.mask_text(body) <> body;
  body := game.mask_text(body);
end $$;

create function public.get_filter_patterns() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select jsonb_build_object('words', coalesce((select jsonb_agg(game.filter_pattern(word)) from game.filter_words), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Public identity helpers
-- ---------------------------------------------------------------------------
create function game.ring_for(p_worth bigint) returns text
language sql immutable set search_path = game, pg_temp as $$
  select case when p_worth >= 50000000000 then 'diamond' when p_worth >= 5000000000 then 'gold'
              when p_worth >= 500000000 then 'silver' when p_worth >= 50000000 then 'bronze' else 'none' end
$$;

create function game.player_by_no(p_no bigint) returns game.players
language plpgsql stable set search_path = game, pg_temp as $$
declare
  p game.players;
begin
  select * into p from game.players where player_no = p_no and status <> 'deleted';
  if not found then perform game.fail('Player not found.'); end if;
  return p;
end $$;

create function game.public_player(p game.players) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object('player_no', p.player_no, 'name', p.display_name, 'title', p.title, 'skin', p.skin,
    'ring', game.ring_for(p.net_worth), 'ring_style', p.ring_style)
$$;

-- ---------------------------------------------------------------------------
-- Blocks (mute and block are the same thing: hide them from yourself, and
-- they can't message you).
-- ---------------------------------------------------------------------------
create table game.blocks (
  player_id uuid not null references game.players(id),
  blocked_id uuid not null references game.players(id),
  created_at timestamptz not null default now(),
  primary key (player_id, blocked_id)
);

create function public.block_player(p_player_no bigint, p_block boolean default true) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  t game.players := game.player_by_no(p_player_no);
begin
  if t.id = p.id then perform game.fail('You can''t block yourself.'); end if;
  if p_block then
    insert into game.blocks (player_id, blocked_id) values (p.id, t.id) on conflict do nothing;
  else
    delete from game.blocks where player_id = p.id and blocked_id = t.id;
  end if;
  return jsonb_build_object('blocked', p_block, 'player_no', t.player_no);
end $$;

create function public.my_blocks() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(game.public_player(t) || jsonb_build_object('since', b.created_at))
    from game.blocks b join game.players t on t.id = b.blocked_id where b.player_id = p.id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
create table game.chat_channels (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('global', 'city', 'custom', 'dm')),
  city_id text references game.cities(id),
  name text not null,
  owner_id uuid references game.players(id),
  dm_a uuid references game.players(id),
  dm_b uuid references game.players(id),
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);
create unique index chat_city_unique on game.chat_channels (city_id) where kind = 'city';
create unique index chat_global_unique on game.chat_channels (kind) where kind = 'global';
create unique index chat_custom_unique on game.chat_channels (lower(name)) where kind = 'custom';
create unique index chat_dm_unique on game.chat_channels (dm_a, dm_b) where kind = 'dm';

create table game.chat_members (
  channel_id bigint not null references game.chat_channels(id) on delete cascade,
  player_id uuid not null references game.players(id),
  joined_at timestamptz not null default now(),
  last_read_id bigint not null default 0,
  primary key (channel_id, player_id)
);
create index chat_members_player_idx on game.chat_members (player_id);

create table game.chat_messages (
  id bigint generated always as identity primary key,
  channel_id bigint not null references game.chat_channels(id) on delete cascade,
  player_id uuid not null references game.players(id),
  body text not null,
  masked boolean not null default false,
  at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text
);
create index chat_messages_channel_idx on game.chat_messages (channel_id, id desc);
create index chat_messages_player_idx on game.chat_messages (player_id, at desc);

insert into game.chat_channels (kind, name) values ('global', 'Global');

create function game.ensure_city_channels() returns void
language sql set search_path = game, pg_temp as $$
  insert into game.chat_channels (kind, city_id, name)
  select 'city', c.id, c.name from game.cities c
  on conflict (city_id) where kind = 'city' do nothing
$$;

create function game.message_json(m game.chat_messages) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object('id', m.id, 'channel_id', m.channel_id, 'at', m.at,
    'body', case when m.removed_at is null then m.body end,
    'removed', m.removed_at is not null, 'removed_reason', m.removed_reason,
    'author', game.public_player(p))
  from game.players p where p.id = m.player_id
$$;

create function game.can_read_channel(p game.players, ch game.chat_channels) returns boolean
language sql stable set search_path = game, pg_temp as $$
  select case ch.kind
    when 'global' then true
    when 'city' then true
    else exists (select 1 from game.chat_members m where m.channel_id = ch.id and m.player_id = p.id) end
$$;

create function public.chat_channels() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  perform game.ensure_city_channels();
  return coalesce((select jsonb_agg(x order by x ->> 'sort', x ->> 'name') from (
    select jsonb_build_object('id', ch.id, 'kind', ch.kind, 'name', ch.name, 'city_id', ch.city_id,
      'sort', case ch.kind when 'city' then case when ch.city_id = p.city_id then '0' else '3' end when 'global' then '1' when 'custom' then '2' else '4' end,
      'can_post', case ch.kind when 'global' then game.cfg('global_chat_enabled') = 1
                               when 'city' then ch.city_id = p.city_id else true end,
      'unread', (select count(*) from game.chat_messages cm where cm.channel_id = ch.id
                   and cm.id > coalesce((select last_read_id from game.chat_members m where m.channel_id = ch.id and m.player_id = p.id), 0)
                   and cm.player_id <> p.id and ch.kind in ('dm', 'custom')),
      'with', case when ch.kind = 'dm' then (select game.public_player(o) from game.players o
                    where o.id = case when ch.dm_a = p.id then ch.dm_b else ch.dm_a end) end,
      'last_message_at', ch.last_message_at) x
    from game.chat_channels ch
   where (ch.kind = 'city') or (ch.kind = 'global' and game.cfg('global_chat_enabled') = 1)
      or exists (select 1 from game.chat_members m where m.channel_id = ch.id and m.player_id = p.id)) s), '[]'::jsonb);
end $$;

create function public.chat_history(p_channel bigint, p_before bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  ch game.chat_channels;
  v jsonb;
begin
  select * into ch from game.chat_channels where id = p_channel;
  if not found or not game.can_read_channel(p, ch) then perform game.fail('Channel not found.'); end if;
  select coalesce(jsonb_agg(game.message_json(m) order by m.id), '[]'::jsonb) into v
    from (select * from game.chat_messages
           where channel_id = ch.id and (p_before is null or id < p_before)
             and player_id not in (select blocked_id from game.blocks where player_id = p.id)
           order by id desc limit 60) m;
  update game.chat_members set last_read_id = greatest(last_read_id, coalesce((select max(id) from game.chat_messages where channel_id = ch.id), 0))
   where channel_id = ch.id and player_id = p.id;
  return v;
end $$;

create function public.send_chat(p_channel bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ch game.chat_channels;
  t record;
  m game.chat_messages;
  v_other uuid;
begin
  select * into ch from game.chat_channels where id = p_channel;
  if not found or not game.can_read_channel(p, ch) then perform game.fail('Channel not found.'); end if;
  if ch.kind = 'global' and game.cfg('global_chat_enabled') <> 1 then perform game.fail('Global chat isn''t open yet. Use your city chat.'); end if;
  if ch.kind = 'city' and ch.city_id is distinct from p.city_id then
    perform game.fail(format('You can read %s chat, but only post in the city you''re in.', ch.name));
  end if;
  if ch.kind = 'dm' then
    v_other := case when ch.dm_a = p.id then ch.dm_b else ch.dm_a end;
    if exists (select 1 from game.blocks where (player_id = v_other and blocked_id = p.id) or (player_id = p.id and blocked_id = v_other)) then
      perform game.fail('You can''t message this player.');
    end if;
  end if;
  perform game.rate_limit(p.id::text, 'chat', 5, game.cfg('chat_rate_per_min'));
  select * into t from game.check_text(p_body, 400);
  insert into game.chat_messages (channel_id, player_id, body, masked) values (ch.id, p.id, t.body, t.masked) returning * into m;
  update game.chat_channels set last_message_at = now() where id = ch.id;
  perform game.push('chat:' || ch.id, 'message', game.message_json(m));
  if ch.kind = 'dm' then
    perform game.push('user:' || v_other::text, 'dm', jsonb_build_object('channel_id', ch.id, 'from', p.display_name));
  end if;
  return jsonb_build_object('message', game.message_json(m), 'masked', t.masked,
    'notice', case when t.masked then 'Some words in your message were masked by the filter.' end);
end $$;

create function public.open_dm(p_player_no bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t game.players := game.player_by_no(p_player_no);
  a uuid;
  b uuid;
  v_id bigint;
begin
  if t.id = p.id then perform game.fail('That''s you.'); end if;
  if exists (select 1 from game.blocks where (player_id = t.id and blocked_id = p.id) or (player_id = p.id and blocked_id = t.id)) then
    perform game.fail('You can''t message this player.');
  end if;
  a := least(p.id, t.id);
  b := greatest(p.id, t.id);
  select id into v_id from game.chat_channels where kind = 'dm' and dm_a = a and dm_b = b;
  if v_id is null then
    insert into game.chat_channels (kind, name, dm_a, dm_b) values ('dm', 'Direct message', a, b) returning id into v_id;
    insert into game.chat_members (channel_id, player_id) values (v_id, a), (v_id, b);
  end if;
  return jsonb_build_object('channel_id', v_id);
end $$;

create function public.create_channel(p_name text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_name text := btrim(coalesce(p_name, ''));
  v_id bigint;
begin
  perform game.rate_limit(p.id::text, 'create_channel', 3, 0.1);
  if v_name !~ '^[[:alnum:] _-]{3,24}$' then perform game.fail('Channel names are 3 to 24 letters, numbers, spaces, dashes or underscores.'); end if;
  perform game.check_name(v_name);
  if exists (select 1 from game.chat_channels where kind = 'custom' and lower(name) = lower(v_name)) then
    perform game.fail('That channel exists already. Join it instead.');
  end if;
  insert into game.chat_channels (kind, name, owner_id) values ('custom', v_name, p.id) returning id into v_id;
  insert into game.chat_members (channel_id, player_id) values (v_id, p.id);
  return jsonb_build_object('channel_id', v_id, 'name', v_name);
end $$;

create function public.join_channel(p_name text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  ch game.chat_channels;
begin
  select * into ch from game.chat_channels where kind = 'custom' and lower(name) = lower(btrim(coalesce(p_name, '')));
  if not found then perform game.fail('No channel with that name. You can create it.'); end if;
  insert into game.chat_members (channel_id, player_id) values (ch.id, p.id) on conflict do nothing;
  return jsonb_build_object('channel_id', ch.id, 'name', ch.name);
end $$;

create function public.leave_channel(p_channel bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  delete from game.chat_members m using game.chat_channels ch
   where m.channel_id = ch.id and ch.id = p_channel and m.player_id = p.id and ch.kind = 'custom';
  return jsonb_build_object('ok', true);
end $$;

create function public.popular_channels() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'members', n) order by n desc), '[]'::jsonb)
  from (select ch.id, ch.name, (select count(*) from game.chat_members m where m.channel_id = ch.id) n
          from game.chat_channels ch where ch.kind = 'custom' order by 3 desc limit 30) x
$$;

-- ---------------------------------------------------------------------------
-- Friends
-- ---------------------------------------------------------------------------
create table game.friends (
  a uuid not null references game.players(id),
  b uuid not null references game.players(id),
  requested_by uuid not null references game.players(id),
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);

create function public.friend_request(p_player_no bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t game.players := game.player_by_no(p_player_no);
  f game.friends;
begin
  if t.id = p.id then perform game.fail('That''s you.'); end if;
  perform game.rate_limit(p.id::text, 'friend', 10, 1);
  if exists (select 1 from game.blocks where player_id = t.id and blocked_id = p.id) then
    perform game.fail('You can''t add this player.');
  end if;
  select * into f from game.friends where a = least(p.id, t.id) and b = greatest(p.id, t.id);
  if found then
    if f.status = 'pending' and f.requested_by = t.id then
      update game.friends set status = 'accepted' where a = f.a and b = f.b;
      perform game.notify(t.id, 'friend', format('%s accepted your friend request', p.display_name));
      return jsonb_build_object('status', 'accepted');
    end if;
    return jsonb_build_object('status', f.status);
  end if;
  insert into game.friends (a, b, requested_by) values (least(p.id, t.id), greatest(p.id, t.id), p.id);
  perform game.notify(t.id, 'friend', format('%s wants to be friends', p.display_name), 'Open Community → Friends to accept.',
    jsonb_build_object('player_no', p.player_no));
  return jsonb_build_object('status', 'pending');
end $$;

create function public.friend_respond(p_player_no bigint, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  t game.players := game.player_by_no(p_player_no);
begin
  if p_accept then
    update game.friends set status = 'accepted' where a = least(p.id, t.id) and b = greatest(p.id, t.id) and requested_by = t.id;
    if found then perform game.notify(t.id, 'friend', format('%s accepted your friend request', p.display_name)); end if;
  else
    delete from game.friends where a = least(p.id, t.id) and b = greatest(p.id, t.id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.my_friends() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return coalesce((select jsonb_agg(game.public_player(o) || jsonb_build_object(
      'status', f.status, 'incoming', f.status = 'pending' and f.requested_by <> p.id,
      'city_id', case when f.status = 'accepted' then o.city_id end,
      'last_seen_at', case when f.status = 'accepted' then o.last_seen_at end,
      'online', f.status = 'accepted' and o.last_seen_at > now() - interval '5 minutes') order by o.last_seen_at desc)
    from game.friends f join game.players o on o.id = case when f.a = p.id then f.b else f.a end
   where (f.a = p.id or f.b = p.id) and o.status <> 'deleted'), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Bug Reports and Suggestions boards
-- ---------------------------------------------------------------------------
create table game.board_posts (
  id bigint generated always as identity primary key,
  board text not null check (board in ('bugs', 'ideas')),
  player_id uuid not null references game.players(id),
  title text not null,
  body text not null,
  screenshot text,
  status text not null default 'open' check (status in ('open', 'planned', 'in_progress', 'done', 'duplicate', 'wont_do')),
  merged_into bigint references game.board_posts(id),
  staff_note text,
  votes int not null default 0,
  comments int not null default 0,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text
);
create index board_posts_idx on game.board_posts (board, status, votes desc);

create table game.board_votes (
  post_id bigint not null references game.board_posts(id) on delete cascade,
  player_id uuid not null references game.players(id),
  primary key (post_id, player_id)
);

create table game.board_comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references game.board_posts(id) on delete cascade,
  player_id uuid not null references game.players(id),
  body text not null,
  at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text
);

create function game.post_json(bp game.board_posts, p_uid uuid) returns jsonb
language sql stable set search_path = game, pg_temp as $$
  select jsonb_build_object('id', bp.id, 'board', bp.board,
    'title', case when bp.removed_at is null then bp.title else 'Removed by staff' end,
    'body', case when bp.removed_at is null then bp.body end,
    'screenshot', case when bp.removed_at is null then bp.screenshot end,
    'status', bp.status, 'merged_into', bp.merged_into, 'staff_note', bp.staff_note,
    'votes', bp.votes, 'comments', bp.comments, 'created_at', bp.created_at,
    'removed', bp.removed_at is not null, 'removed_reason', bp.removed_reason,
    'voted', exists (select 1 from game.board_votes v where v.post_id = bp.id and v.player_id = p_uid),
    'mine', bp.player_id = p_uid,
    'author', (select game.public_player(p) from game.players p where p.id = bp.player_id))
$$;

create function public.board_list(p_board text, p_sort text default 'top', p_status text default null) returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(game.post_json(bp, game.uid())
    order by case when p_sort = 'new' then extract(epoch from bp.created_at) else bp.votes end desc, bp.id desc), '[]'::jsonb)
  from (select * from game.board_posts where board = p_board and (p_status is null or status = p_status)
         order by case when p_sort = 'new' then extract(epoch from created_at) else votes end desc, id desc limit 100) bp
$$;

create function public.board_post(p_id bigint) returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select game.post_json(bp, game.uid()) || jsonb_build_object('comments_list', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'at', c.at,
      'body', case when c.removed_at is null then c.body end, 'removed', c.removed_at is not null, 'removed_reason', c.removed_reason,
      'author', (select game.public_player(p) from game.players p where p.id = c.player_id)) order by c.id)
    from game.board_comments c where c.post_id = bp.id), '[]'::jsonb))
  from game.board_posts bp where bp.id = p_id
$$;

create function public.board_create(p_board text, p_title text, p_body text, p_screenshot text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t record;
  b record;
  v_id bigint;
begin
  if p_board not in ('bugs', 'ideas') then perform game.fail('Choose Bug Reports or Suggestions.'); end if;
  perform game.rate_limit(p.id::text, 'board_post', 3, 0.2);
  select * into t from game.check_text(p_title, 120);
  select * into b from game.check_text(p_body, 4000);
  if p_screenshot is not null and p_screenshot !~ ('^' || p.id::text || '/[A-Za-z0-9._-]{1,80}$') then
    perform game.fail('Screenshot upload not recognised. Try attaching it again.');
  end if;
  insert into game.board_posts (board, player_id, title, body, screenshot) values (p_board, p.id, t.body, b.body, p_screenshot)
  returning id into v_id;
  insert into game.board_votes (post_id, player_id) values (v_id, p.id);
  update game.board_posts set votes = 1 where id = v_id;
  return jsonb_build_object('id', v_id, 'masked', t.masked or b.masked,
    'notice', case when t.masked or b.masked then 'Some words were masked by the filter.' end);
end $$;

create function public.board_vote(p_id bigint, p_vote boolean) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
begin
  if p_vote then
    insert into game.board_votes (post_id, player_id) values (p_id, p.id) on conflict do nothing;
  else
    delete from game.board_votes where post_id = p_id and player_id = p.id;
  end if;
  update game.board_posts set votes = (select count(*) from game.board_votes where post_id = p_id) where id = p_id;
  return jsonb_build_object('votes', (select votes from game.board_posts where id = p_id));
end $$;

create function public.board_comment(p_id bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t record;
  v_owner uuid;
begin
  select player_id into v_owner from game.board_posts where id = p_id and removed_at is null;
  if not found then perform game.fail('Post not found.'); end if;
  perform game.rate_limit(p.id::text, 'board_comment', 5, 1);
  select * into t from game.check_text(p_body, 2000);
  insert into game.board_comments (post_id, player_id, body) values (p_id, p.id, t.body);
  update game.board_posts set comments = comments + 1 where id = p_id;
  if v_owner <> p.id then
    perform game.notify(v_owner, 'board', format('%s commented on your post', p.display_name), left(t.body, 140), jsonb_build_object('post', p_id));
  end if;
  return jsonb_build_object('ok', true, 'notice', case when t.masked then 'Some words were masked by the filter.' end);
end $$;

-- Staff: set status, merge duplicates.
create function public.board_set_status(p_id bigint, p_status text, p_merged_into bigint default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  bp game.board_posts;
begin
  perform game.require_staff(p);
  select * into bp from game.board_posts where id = p_id;
  if not found then perform game.fail('Post not found.'); end if;
  if p_status = 'duplicate' then
    if p_merged_into is null or p_merged_into = p_id or not exists (select 1 from game.board_posts where id = p_merged_into) then
      perform game.fail('Choose the post this duplicates.');
    end if;
    -- Votes move to the original.
    insert into game.board_votes (post_id, player_id) select p_merged_into, player_id from game.board_votes where post_id = p_id on conflict do nothing;
    update game.board_posts set votes = (select count(*) from game.board_votes where post_id = p_merged_into) where id = p_merged_into;
  end if;
  update game.board_posts set status = p_status, merged_into = case when p_status = 'duplicate' then p_merged_into end,
         staff_note = coalesce(p_note, staff_note) where id = p_id;
  if bp.board = 'bugs' and p_status in ('planned', 'in_progress', 'done') then
    perform game.award(bp.player_id, 'bug_hunter', format('Bug report #%s', bp.id));
  end if;
  perform game.notify(bp.player_id, 'board', format('Your post is now: %s', replace(p_status, '_', ' ')), coalesce(p_note, bp.title),
    jsonb_build_object('post', p_id));
  insert into game.staff_actions (staff_id, target_player_id, action, reason, ref)
  values (p.id, bp.player_id, 'board_status', coalesce(p_note, p_status), jsonb_build_object('post', p_id, 'status', p_status));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Discord servers directory. Players give an invite code; the game builds
-- the link itself, so this is the one place a link can appear.
-- ---------------------------------------------------------------------------
create table game.discord_servers (
  id bigint generated always as identity primary key,
  player_id uuid not null references game.players(id),
  code text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text
);

create function public.discord_directory() returns jsonb
language sql stable security definer set search_path = game, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'url', 'https://discord.gg/' || d.code,
    'name', d.name, 'description', d.description, 'created_at', d.created_at, 'mine', d.player_id = game.uid(),
    'owner', (select game.public_player(p) from game.players p where p.id = d.player_id)) order by d.created_at desc), '[]'::jsonb)
  from game.discord_servers d where d.removed_at is null
$$;

create function public.discord_add(p_code text, p_name text, p_description text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  v_code text := btrim(coalesce(p_code, ''));
  d record;
  v_desc text;
begin
  perform game.rate_limit(p.id::text, 'discord_add', 2, 0.05);
  v_code := regexp_replace(v_code, '^(https?://)?(www\.)?(discord\.gg/|discord\.com/invite/)', '', 'i');
  if v_code !~ '^[A-Za-z0-9-]{2,32}$' then perform game.fail('Enter just the invite code, like "abc123".'); end if;
  perform game.check_name(btrim(p_name));
  if length(btrim(coalesce(p_name, ''))) < 3 or length(p_name) > 40 then perform game.fail('Server names are 3 to 40 characters.'); end if;
  if p_description is not null and btrim(p_description) <> '' then
    select * into d from game.check_text(p_description, 200);
    v_desc := d.body;
  end if;
  if exists (select 1 from game.discord_servers where code = v_code) then perform game.fail('That server is already listed.'); end if;
  insert into game.discord_servers (player_id, code, name, description) values (p.id, v_code, btrim(p_name), v_desc);
  return jsonb_build_object('ok', true, 'url', 'https://discord.gg/' || v_code);
end $$;

create function public.discord_remove(p_id bigint) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  delete from game.discord_servers where id = p_id and player_id = p.id;
  if not found then perform game.fail('You can only remove servers you listed.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Reports and moderation
-- ---------------------------------------------------------------------------
create table game.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references game.players(id),
  target_player_id uuid references game.players(id),
  target_kind text not null check (target_kind in ('player', 'message', 'post', 'comment', 'business', 'discord')),
  target_id bigint,
  reason text not null,
  details text,
  snapshot text,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  handled_by uuid references game.players(id),
  handled_at timestamptz,
  resolution text,
  created_at timestamptz not null default now()
);
create index reports_open_idx on game.reports (status, created_at);

create table game.illegal_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  location text not null,
  description text not null,
  contact text,
  reporter_hash text,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  handled_by uuid references game.players(id),
  handled_at timestamptz,
  resolution text
);

create table game.staff_actions (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id uuid not null references game.players(id),
  target_player_id uuid references game.players(id),
  action text not null,
  reason text not null,
  ref jsonb
);
create index staff_actions_target_idx on game.staff_actions (target_player_id, at desc);

create function public.report(p_kind text, p_target bigint, p_reason text, p_details text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v_target uuid;
  v_snap text;
begin
  perform game.rate_limit(p.id::text, 'report', 5, 0.5);
  if p_reason not in ('harassment', 'hate', 'spam', 'impersonation', 'personal_info', 'cheating', 'scam', 'name', 'other') then
    perform game.fail('Choose a reason.');
  end if;
  case p_kind
    when 'player' then select id, display_name into v_target, v_snap from game.players where player_no = p_target;
    when 'message' then select player_id, body into v_target, v_snap from game.chat_messages where id = p_target;
    when 'post' then select player_id, title || E'\n' || body into v_target, v_snap from game.board_posts where id = p_target;
    when 'comment' then select player_id, body into v_target, v_snap from game.board_comments where id = p_target;
    when 'business' then select owner_id, name into v_target, v_snap from game.businesses where id = p_target;
    when 'discord' then select player_id, name || ' ' || coalesce(description, '') into v_target, v_snap from game.discord_servers where id = p_target;
    else perform game.fail('Unknown report type.');
  end case;
  if v_target is null then perform game.fail('Nothing to report there.'); end if;
  insert into game.reports (reporter_id, target_player_id, target_kind, target_id, reason, details, snapshot)
  values (p.id, v_target, p_kind, p_target, p_reason, left(p_details, 1000), left(v_snap, 2000));
  return jsonb_build_object('ok', true, 'message', 'Thanks. A person on the moderation team will look at this.');
end $$;

-- Public form: anyone, signed in or not, can report illegal content.
create function public.report_illegal_content(p_location text, p_description text, p_contact text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  v_hdr jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_ip text := coalesce(split_part(v_hdr ->> 'x-forwarded-for', ',', 1), v_hdr ->> 'x-real-ip', 'unknown');
  v_hash text := encode(extensions.digest(v_ip || (select value from game.secrets where key = 'deposit_salt'), 'sha256'), 'hex');
begin
  perform game.rate_limit('ip:' || v_hash, 'illegal_report', 3, 0.1);
  if length(btrim(coalesce(p_location, ''))) < 2 or length(btrim(coalesce(p_description, ''))) < 10 then
    perform game.fail('Tell us where the content is and what''s wrong with it (at least 10 characters).');
  end if;
  insert into game.illegal_reports (location, description, contact, reporter_hash)
  values (left(btrim(p_location), 500), left(btrim(p_description), 5000), left(nullif(btrim(p_contact), ''), 200), v_hash);
  return jsonb_build_object('ok', true, 'message', 'Thank you. Your report was received and a person will review it.');
end $$;

create function public.mod_queue() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
begin
  perform game.require_staff(p);
  return jsonb_build_object(
    'reports', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'created_at', r.created_at, 'kind', r.target_kind, 'target_id', r.target_id,
        'reason', r.reason, 'details', r.details, 'snapshot', r.snapshot,
        'reporter', (select game.public_player(x) from game.players x where x.id = r.reporter_id),
        'target', (select game.public_player(x) || jsonb_build_object('status', x.status) from game.players x where x.id = r.target_player_id),
        'target_reports', (select count(*) from game.reports r2 where r2.target_player_id = r.target_player_id),
        'target_history', (select coalesce(jsonb_agg(jsonb_build_object('at', s.at, 'action', s.action, 'reason', s.reason) order by s.at desc), '[]'::jsonb)
                             from (select * from game.staff_actions s where s.target_player_id = r.target_player_id order by at desc limit 5) s)
      ) order by r.created_at), '[]'::jsonb) from game.reports r where r.status = 'open'),
    'illegal', (select coalesce(jsonb_agg(to_jsonb(i) - 'reporter_hash' order by i.created_at), '[]'::jsonb) from game.illegal_reports i where i.status = 'open'),
    'recent_actions', (select coalesce(jsonb_agg(jsonb_build_object('at', s.at, 'action', s.action, 'reason', s.reason,
        'staff', (select display_name from game.players where id = s.staff_id),
        'target', (select display_name from game.players where id = s.target_player_id)) order by s.at desc), '[]'::jsonb)
      from (select * from game.staff_actions order by at desc limit 30) s)
  );
end $$;

-- Remove a piece of content (soft: replaced by "Removed by staff" + reason).
create function game.remove_content(p_kind text, p_id bigint, p_reason text) returns uuid
language plpgsql set search_path = game, pg_temp as $$
declare
  v uuid;
begin
  case p_kind
    when 'message' then update game.chat_messages set removed_at = now(), removed_reason = p_reason where id = p_id returning player_id into v;
    when 'post' then update game.board_posts set removed_at = now(), removed_reason = p_reason where id = p_id returning player_id into v;
    when 'comment' then update game.board_comments set removed_at = now(), removed_reason = p_reason where id = p_id returning player_id into v;
    when 'discord' then update game.discord_servers set removed_at = now(), removed_reason = p_reason where id = p_id returning player_id into v;
    when 'business' then update game.businesses set name = 'Business #' || id where id = p_id returning owner_id into v;
    else null;
  end case;
  return v;
end $$;

-- One entry point for every staff decision: always by a person, always
-- with a reason the player sees.
create function public.mod_action(p_target_player_no bigint, p_action text, p_reason text,
  p_hours int default null, p_report bigint default null, p_content_kind text default null, p_content_id bigint default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  t game.players;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform game.require_staff(p, p_action = 'ban');
  if length(v_reason) < 5 then perform game.fail('Give the player a reason (at least 5 characters).'); end if;
  if p_action not in ('dismiss', 'warn', 'remove', 'suspend', 'ban', 'unban', 'rename') then perform game.fail('Unknown action.'); end if;
  if p_target_player_no is not null then
    t := game.player_by_no(p_target_player_no);
    if t.role = 'admin' and p.role <> 'admin' then perform game.fail('Moderators can''t act on admins.'); end if;
  end if;
  if p_action = 'remove' then
    if p_content_kind is null then perform game.fail('Say what to remove.'); end if;
    perform game.remove_content(p_content_kind, p_content_id, v_reason);
  elsif p_action = 'suspend' then
    if p_hours is null or p_hours < 1 or p_hours > 24 * 90 then perform game.fail('Suspend for 1 hour to 90 days.'); end if;
    update game.players set status = 'suspended', status_until = now() + make_interval(hours => p_hours), status_reason = v_reason where id = t.id;
  elsif p_action = 'ban' then
    update game.players set status = 'banned', status_until = null, status_reason = v_reason where id = t.id;
  elsif p_action = 'unban' then
    update game.players set status = 'active', status_until = null, status_reason = null where id = t.id;
  elsif p_action = 'rename' then
    update game.players set display_name = 'Player ' || player_no where id = t.id;
  end if;
  if t.id is not null and p_action <> 'dismiss' then
    perform game.notify(t.id, 'moderation',
      case p_action when 'warn' then 'A warning from the moderation team'
                    when 'remove' then 'Staff removed something you posted'
                    when 'suspend' then format('Your account is suspended for %s hours', p_hours)
                    when 'ban' then 'Your account has been banned'
                    when 'unban' then 'Your account has been restored'
                    when 'rename' then 'Staff reset your display name' end,
      'Reason: ' || v_reason, jsonb_build_object('action', p_action));
  end if;
  insert into game.staff_actions (staff_id, target_player_id, action, reason, ref)
  values (p.id, t.id, p_action, v_reason, jsonb_build_object('report', p_report, 'content_kind', p_content_kind, 'content_id', p_content_id, 'hours', p_hours));
  if p_report is not null then
    update game.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
           handled_by = p.id, handled_at = now(), resolution = p_action || ': ' || v_reason where id = p_report;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.mod_illegal_resolve(p_id bigint, p_status text, p_resolution text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
begin
  perform game.require_staff(p);
  if p_status not in ('actioned', 'dismissed') then perform game.fail('Choose actioned or dismissed.'); end if;
  update game.illegal_reports set status = p_status, handled_by = p.id, handled_at = now(), resolution = p_resolution where id = p_id;
  insert into game.staff_actions (staff_id, action, reason, ref) values (p.id, 'illegal_report', coalesce(p_resolution, p_status), jsonb_build_object('id', p_id));
  return jsonb_build_object('ok', true);
end $$;

-- What staff have done to my account, with reasons (transparency).
create function public.my_moderation() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object('status', p.status, 'until', p.status_until, 'reason', p.status_reason,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'action', action, 'reason', reason) order by at desc), '[]'::jsonb)
                  from game.staff_actions where target_player_id = p.id and action not in ('board_status')));
end $$;

-- Possible multi-accounts: players sharing a device fingerprint who trade with each other.
create table game.player_devices (
  player_id uuid not null references game.players(id),
  device_hash text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (player_id, device_hash)
);

create function game.record_device(p_player uuid) returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_hdr jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_hash text;
begin
  v_hash := encode(extensions.digest(coalesce(split_part(v_hdr ->> 'x-forwarded-for', ',', 1), '') || '|' || coalesce(v_hdr ->> 'user-agent', '')
    || (select value from game.secrets where key = 'deposit_salt'), 'sha256'), 'hex');
  insert into game.player_devices (player_id, device_hash) values (p_player, v_hash)
  on conflict (player_id, device_hash) do update set last_seen = now();
end $$;

create function public.mod_multi_accounts() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
begin
  perform game.require_staff(p);
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('players', jsonb_agg(distinct game.public_player(pl)), 'shared_devices', count(distinct d1.device_hash),
      'trades_between', (select count(*) from game.trades t where t.buyer_id = d1.player_id and t.seller_id = d2.player_id
                            or t.buyer_id = d2.player_id and t.seller_id = d1.player_id)) x
      from game.player_devices d1 join game.player_devices d2 on d1.device_hash = d2.device_hash and d1.player_id < d2.player_id
      join game.players pl on pl.id in (d1.player_id, d2.player_id)
     where d1.last_seen > now() - interval '30 days'
     group by d1.player_id, d2.player_id limit 100) s), '[]'::jsonb);
end $$;

-- Owner tool, run from the SQL editor: make a player staff.
create function game.make_staff(p_player_no bigint, p_role text default 'admin') returns text
language plpgsql set search_path = game, pg_temp as $$
begin
  if p_role not in ('player', 'mod', 'admin') then raise exception 'role must be player, mod or admin'; end if;
  update game.players set role = p_role where player_no = p_player_no;
  return format('player #%s is now %s', p_player_no, p_role);
end $$;

-- ---------------------------------------------------------------------------
-- Cosmetics: skins, titles and ring styles. Free, earned through badges, or
-- bought with loyalty points. Never with money.
-- ---------------------------------------------------------------------------
create table game.cosmetics (
  id text primary key,
  kind text not null check (kind in ('skin', 'title', 'ring_style')),
  name text not null,
  points int not null default 0,
  requires_badge text references game.badges(id),
  requires_tier int,
  sort smallint not null default 0
);
insert into game.cosmetics (id, kind, name, points, requires_badge, requires_tier, sort) values
  ('classic', 'skin', 'Classic', 0, null, null, 1),
  ('mint', 'skin', 'Mint', 0, null, null, 2),
  ('coral', 'skin', 'Coral', 0, null, null, 3),
  ('sky', 'skin', 'Sky', 0, null, null, 4),
  ('sunny', 'skin', 'Sunny', 0, null, null, 5),
  ('night', 'skin', 'Night', 0, null, null, 6),
  ('sprout', 'skin', 'Sprout', 0, 'founder', null, 10),
  ('graduate', 'skin', 'Graduate', 0, 'tutorial', null, 11),
  ('hardhat', 'skin', 'Hard Hat', 0, 'first_mine', null, 12),
  ('captain', 'skin', 'Captain', 0, 'first_export', null, 13),
  ('tycoon', 'skin', 'Tycoon', 0, 'first_million', null, 14),
  ('gilded', 'skin', 'Gilded', 300, null, null, 20),
  ('neon', 'skin', 'Neon', 200, null, null, 21),
  ('marble', 'skin', 'Marble', 250, null, null, 22),
  ('t_vendor', 'title', 'Street Vendor', 0, null, null, 1),
  ('t_hustler', 'title', 'Hustler', 0, null, null, 2),
  ('t_restaurateur', 'title', 'Restaurateur', 0, null, 2, 3),
  ('t_landlord', 'title', 'Landlord', 0, null, 3, 4),
  ('t_prospector', 'title', 'Prospector', 0, null, 4, 5),
  ('t_industrialist', 'title', 'Industrialist', 0, null, 5, 6),
  ('t_financier', 'title', 'Financier', 0, null, 6, 7),
  ('t_globetrotter', 'title', 'Globetrotter', 0, 'globetrotter', null, 8),
  ('t_bug_hunter', 'title', 'Bug Hunter', 0, 'bug_hunter', null, 9),
  ('t_mogul', 'title', 'Mogul', 150, null, null, 20),
  ('t_baron', 'title', 'Baron', 150, null, null, 21),
  ('t_maverick', 'title', 'Maverick', 100, null, null, 22),
  ('standard', 'ring_style', 'Standard ring', 0, null, null, 1),
  ('double', 'ring_style', 'Double ring', 120, null, null, 2),
  ('pulse', 'ring_style', 'Pulsing ring', 200, null, null, 3),
  ('sparkle', 'ring_style', 'Sparkle ring', 300, null, null, 4);

create table game.player_cosmetics (
  player_id uuid not null references game.players(id),
  cosmetic_id text not null references game.cosmetics(id),
  at timestamptz not null default now(),
  primary key (player_id, cosmetic_id)
);

create function game.owns_cosmetic(p game.players, c game.cosmetics) returns boolean
language sql stable set search_path = game, pg_temp as $$
  select (c.points = 0 and c.requires_badge is null and c.requires_tier is null)
      or (c.requires_tier is not null and p.tier >= c.requires_tier)
      or (c.requires_badge is not null and exists (select 1 from game.player_badges b where b.player_id = p.id and b.badge_id = c.requires_badge))
      or exists (select 1 from game.player_cosmetics pc where pc.player_id = p.id and pc.cosmetic_id = c.id)
$$;

create function public.my_cosmetics() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object('points', p.loyalty_points, 'items', (select jsonb_agg(to_jsonb(c) || jsonb_build_object('owned', game.owns_cosmetic(p, c)) order by c.kind, c.sort)
    from game.cosmetics c));
end $$;

create function public.buy_cosmetic(p_id text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cosmetics;
begin
  select * into c from game.cosmetics where id = p_id;
  if not found or c.points <= 0 then perform game.fail('That can''t be bought.'); end if;
  if game.owns_cosmetic(p, c) then perform game.fail('You already have it.'); end if;
  update game.players set loyalty_points = loyalty_points - c.points where id = p.id and loyalty_points >= c.points;
  if not found then perform game.fail(format('You need %s loyalty points.', c.points)); end if;
  insert into game.player_cosmetics (player_id, cosmetic_id) values (p.id, c.id);
  return jsonb_build_object('ok', true);
end $$;

create function public.set_profile(p_name text default null, p_title text default null, p_skin text default null, p_ring_style text default null) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me();
  c game.cosmetics;
  v_name text;
begin
  if p_name is not null and p_name <> p.display_name then
    perform game.rate_limit(p.id::text, 'rename', 2, 0.002);
    v_name := game.check_display_name(p_name);
    if exists (select 1 from game.players where lower(display_name) = lower(v_name) and id <> p.id and status <> 'deleted') then
      perform game.fail('That name is taken.');
    end if;
    update game.players set display_name = v_name where id = p.id;
  end if;
  if p_title is not null then
    if p_title = '' then
      update game.players set title = null where id = p.id;
    else
      select * into c from game.cosmetics where id = p_title and kind = 'title';
      if not found or not game.owns_cosmetic(p, c) then perform game.fail('You haven''t unlocked that title.'); end if;
      update game.players set title = c.name where id = p.id;
    end if;
  end if;
  if p_skin is not null then
    select * into c from game.cosmetics where id = p_skin and kind = 'skin';
    if not found or not game.owns_cosmetic(p, c) then perform game.fail('You haven''t unlocked that skin.'); end if;
    update game.players set skin = c.id where id = p.id;
  end if;
  if p_ring_style is not null then
    select * into c from game.cosmetics where id = p_ring_style and kind = 'ring_style';
    if not found or not game.owns_cosmetic(p, c) then perform game.fail('You haven''t unlocked that ring.'); end if;
    update game.players set ring_style = c.id where id = p.id;
  end if;
  select * into p from game.players where id = p.id;
  return game.player_json(p);
end $$;

create function public.set_prefs(p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v jsonb := '{}'::jsonb;
  k text;
begin
  for k in select jsonb_object_keys(p_prefs) loop
    if k in ('notify_launch', 'notify_digest', 'notify_events', 'analytics', 'show_crowds', 'reduce_motion', 'sound', 'units') then
      v := v || jsonb_build_object(k, p_prefs -> k);
    end if;
  end loop;
  update game.players set prefs = prefs || v where id = p.id returning * into p;
  return p.prefs;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles and leaderboards
-- ---------------------------------------------------------------------------
create function public.public_profile(p_player_no bigint) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  t game.players;
  v_uid uuid := game.uid();
  v_friend boolean;
begin
  select * into t from game.players where player_no = p_player_no and status <> 'deleted';
  if not found then return null; end if;
  v_friend := exists (select 1 from game.friends f where f.status = 'accepted' and f.a = least(t.id, v_uid) and f.b = greatest(t.id, v_uid));
  return game.public_player(t) || jsonb_build_object(
    'member_since', t.created_at, 'days_played', t.days_played, 'net_worth', t.net_worth, 'tier', t.tier,
    'status', case when t.status = 'banned' then 'banned' else 'active' end,
    'badges', (select coalesce(jsonb_agg(jsonb_build_object('badge', b.badge_id, 'earned_at', b.earned_at) order by b.earned_at), '[]'::jsonb)
                 from game.player_badges b where b.player_id = t.id),
    'businesses', (select count(*) from game.businesses where owner_id = t.id and status in ('open', 'closed')),
    'buildings', (select count(*) from game.buildings where owner_id = t.id),
    'plots', (select count(*) from game.plots where owner_id = t.id),
    'rank', (select count(*) + 1 from game.players o where o.status = 'active' and o.net_worth > t.net_worth),
    'is_friend', v_friend,
    'city_id', case when v_friend or t.id = v_uid then t.city_id end,
    'online', case when v_friend or t.id = v_uid then t.last_seen_at > now() - interval '5 minutes' end,
    'me', t.id = v_uid,
    'blocked', exists (select 1 from game.blocks where player_id = v_uid and blocked_id = t.id)
  );
end $$;

create function public.leaderboard(p_kind text default 'richest', p_city text default null) returns jsonb
language plpgsql stable security definer set search_path = game, pg_temp as $$
declare
  v_uid uuid := game.uid();
  v jsonb;
begin
  with scored as (
    select p.*, case p_kind
      when 'richest' then case when p_city is null then p.net_worth
        else coalesce((select sum(book_value) from game.businesses b where b.owner_id = p.id and b.city_id = p_city and b.status in ('open', 'closed')), 0)
           + coalesce((select sum(bought_price) from game.plots pt where pt.owner_id = p.id and pt.city_id = p_city), 0)
           + coalesce((select sum(bought_price) from game.buildings bl where bl.owner_id = p.id and bl.city_id = p_city), 0) end
      when 'landowners' then coalesce((select sum(bought_price) from game.plots pt where pt.owner_id = p.id and (p_city is null or pt.city_id = p_city)), 0)
           + coalesce((select sum(bought_price) from game.buildings bl where bl.owner_id = p.id and (p_city is null or bl.city_id = p_city)), 0)
      when 'exporters' then coalesce((select sum(s.delivered_value) from game.shipments s where s.owner_id = p.id and s.kind = 'export'
           and s.status = 'delivered' and s.arrive_at > date_trunc('month', now()) and (p_city is null or s.from_city = p_city)), 0)
      when 'monthly' then p.net_worth - p.month_start_worth
      when 'referrals' then (select count(*) from game.players r where r.referred_by = p.id and r.created_at > date_trunc('month', now()) and r.days_played >= 2)
      else 0 end as score
    from game.players p where p.status = 'active'
  )
  select coalesce(jsonb_agg(jsonb_build_object('player_no', s.player_no, 'name', s.display_name, 'title', s.title, 'skin', s.skin,
           'ring', game.ring_for(s.net_worth), 'ring_style', s.ring_style,
           'score', s.score, 'rank', s.rk, 'me', s.id = v_uid) order by s.rk), '[]'::jsonb)
    into v
    from (select scored.*, rank() over (order by score desc) rk from scored where score > 0) s
   where s.rk <= 50 or s.id = v_uid;
  return jsonb_build_object('kind', p_kind, 'city', p_city, 'rows', v,
    'month', to_char(now(), 'FMMonth YYYY'));
end $$;

-- ---------------------------------------------------------------------------
-- Monthly reset: referral trophies, fresh monthly board.
-- ---------------------------------------------------------------------------
create function game.social_hourly() returns void
language plpgsql set search_path = game, pg_temp as $$
declare
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_prev text;
  r record;
  i int := 0;
begin
  select val ->> 'month' into v_prev from game.state where key = 'month';
  if v_prev is null then
    insert into game.state (key, ts, val) values ('month', now(), jsonb_build_object('month', v_month)) on conflict (key) do nothing;
    update game.players set month_start_worth = net_worth, month_key = v_month where month_key is null;
    return;
  end if;
  if v_prev = v_month then
    update game.players set month_start_worth = net_worth, month_key = v_month where month_key is null;
    return;
  end if;
  -- Trophies for last month's top inviters (referred players who played at least 2 days).
  for r in
    select p.id, count(*) n from game.players p join game.players x on x.referred_by = p.id
     where to_char(x.created_at at time zone 'utc', 'YYYY-MM') = v_prev and x.days_played >= 2 and p.status = 'active'
     group by p.id order by n desc, min(x.created_at) limit 4
  loop
    i := i + 1;
    perform game.award(r.id, (array['trophy_diamond', 'trophy_gold', 'trophy_silver', 'trophy_bronze'])[i], v_prev);
  end loop;
  update game.players set month_start_worth = net_worth, month_key = v_month;
  update game.state set val = jsonb_build_object('month', v_month), ts = now() where key = 'month';
end $$;

-- ---------------------------------------------------------------------------
-- Account tools
-- ---------------------------------------------------------------------------
create function public.my_referrals() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  return jsonb_build_object('code', p.referral_code,
    'this_month', (select count(*) from game.players r where r.referred_by = p.id and r.created_at > date_trunc('month', now()) and r.days_played >= 2),
    'total', (select count(*) from game.players r where r.referred_by = p.id),
    'pending', (select count(*) from game.players r where r.referred_by = p.id and r.days_played < 2),
    'trophies', (select coalesce(jsonb_agg(jsonb_build_object('badge', badge_id, 'month', note) order by earned_at desc), '[]'::jsonb)
                   from game.player_badges where player_id = p.id and badge_id like 'trophy_%'));
end $$;

create function public.my_sessions() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  v jsonb;
begin
  begin
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'created_at', s.created_at, 'updated_at', s.updated_at,
        'user_agent', s.user_agent, 'ip', regexp_replace(host(s.ip), '\.\d+$', '.x')) order by s.updated_at desc nulls last), '[]'::jsonb)
      from auth.sessions s where s.user_id = $1$q$ into v using p.id;
  exception when others then
    v := '[]'::jsonb;
  end;
  return v;
end $$;

create function public.download_my_data() returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
begin
  perform game.rate_limit(p.id::text, 'export', 3, 0.05);
  return jsonb_build_object(
    'exported_at', now(),
    'profile', to_jsonb(p),
    'email', (select email from auth.users where id = p.id),
    'badges', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from game.player_badges b where b.player_id = p.id),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from game.ledger l where l.player_id = p.id),
    'businesses', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from game.businesses b where b.owner_id = p.id),
    'storage', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from game.storage s where s.owner_id = p.id),
    'orders', (select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) from game.orders o where o.player_id = p.id),
    'trades', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from game.trades t where t.buyer_id = p.id or t.seller_id = p.id),
    'plots', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from game.plots x where x.owner_id = p.id),
    'buildings', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(custom_name, name), 'bought_price', bought_price)), '[]'::jsonb)
                    from game.buildings where owner_id = p.id),
    'chat_messages', (select coalesce(jsonb_agg(jsonb_build_object('channel_id', channel_id, 'at', at, 'body', body)), '[]'::jsonb)
                        from game.chat_messages where player_id = p.id),
    'board_posts', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from game.board_posts b where b.player_id = p.id),
    'board_comments', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from game.board_comments c where c.player_id = p.id),
    'reports_made', (select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'kind', target_kind, 'reason', reason, 'status', status)), '[]'::jsonb)
                       from game.reports where reporter_id = p.id),
    'moderation', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'action', action, 'reason', reason)), '[]'::jsonb)
                     from game.staff_actions where target_player_id = p.id),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) from game.notifications n where n.player_id = p.id),
    'friends', public.my_friends(),
    'blocks', public.my_blocks()
  );
end $$;

-- Delete my account: personal data goes; businesses stay on the map as
-- abandoned buildings. Requires typing the display name to confirm.
create function public.delete_account(p_confirm text) returns jsonb
language plpgsql security definer set search_path = game, pg_temp as $$
declare
  p game.players := game.me(false);
  o record;
begin
  if p_confirm is null or lower(btrim(p_confirm)) <> lower(p.display_name) then
    perform game.fail('Type your display name exactly to confirm.');
  end if;
  for o in select id from game.orders where player_id = p.id and status = 'open' loop
    perform game.cancel_order(p, o.id);
  end loop;
  update game.leases set status = 'ended', ended_at = now() where tenant_id = p.id and status = 'active';
  update game.businesses set status = 'abandoned', staff = 0, name = 'Abandoned ' || (select lower(name) from game.business_types where id = kind)
   where owner_id = p.id and status in ('open', 'closed', 'depleted');
  update game.buildings set for_sale_price = null, custom_name = null where owner_id = p.id;
  update game.plots set for_sale_price = null where owner_id = p.id;
  delete from game.chat_messages where player_id = p.id;
  delete from game.chat_members where player_id = p.id;
  delete from game.friends where a = p.id or b = p.id;
  delete from game.blocks where player_id = p.id or blocked_id = p.id;
  delete from game.notifications where player_id = p.id;
  delete from game.player_devices where player_id = p.id;
  update game.board_posts set body = '[deleted]', screenshot = null where player_id = p.id;
  update game.board_comments set body = '[deleted]' where player_id = p.id;
  delete from game.discord_servers where player_id = p.id;
  update game.players
     set display_name = 'Former player ' || player_no, title = null, status = 'deleted', prefs = '{}'::jsonb,
         referral_code = null, lat = null, lng = null, city_id = null, age_ok = false
   where id = p.id;
  begin
    delete from auth.users where id = p.id;
  exception when others then
    -- If the auth record can't be removed here, staff remove it within 30 days.
    insert into game.staff_actions (staff_id, target_player_id, action, reason) values (p.id, p.id, 'delete_auth_pending', sqlerrm);
  end;
  return jsonb_build_object('deleted', true);
end $$;
