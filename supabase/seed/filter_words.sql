-- Words the chat and name filter masks (slurs only; ordinary swearing is
-- allowed by the community rules). Matching ignores case and common
-- disguises like 0 for o or @ for a. Staff can add words with:
--   insert into game.filter_words (word) values ('...') on conflict do nothing;
insert into game.filter_words (word) values
  ('nigger'), ('nigga'), ('faggot'), ('fag'), ('dyke'), ('tranny'), ('retard'), ('retarded'),
  ('spic'), ('kike'), ('chink'), ('gook'), ('wetback'), ('raghead'), ('towelhead'), ('paki'),
  ('coon'), ('jigaboo'), ('beaner'), ('gypo'), ('pikey'), ('sandnigger'), ('shemale'), ('spastic')
on conflict do nothing;
