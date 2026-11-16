# Setting up and running CranCapital

The Supabase project (`akteysagmvayklowjngl`, Paris) already has the game
database, city data, the per-minute tick and sign-in URLs. These are the
steps left for a person to do, then the routine for updates.

## Before launch (one time)

1. **Turn on GitHub Pages.** Repo Settings → Pages → Source: **GitHub Actions**.
   Merging to `main` then publishes the site to
   https://harryxgreenhalgh-prog.github.io/CranCapital/.
2. **Sign in first.** The first player in a fresh world becomes an admin
   (staff tools appear in the dock as 🛡️ Staff). To make someone else staff
   later, run in the Supabase SQL editor:
   `select game.make_staff(<player number>, 'mod');` (or `'admin'`).
3. **Set up email for everyone.** Supabase's built-in email only sends to
   members of your Supabase team, about 2 an hour. Before inviting players,
   add a custom SMTP server (for example Resend, Postmark or Amazon SES) in
   Supabase → Authentication → Emails → SMTP settings. Then run
   `node tools/deploy/supabase.mjs --auth` to add the 6-digit sign-in code to
   the email, so phone players can type the code instead of using the link.
4. **Optional: Google sign-in.** Create an OAuth client in Google Cloud
   (redirect URI `https://akteysagmvayklowjngl.supabase.co/auth/v1/callback`),
   then enable Google in Supabase → Authentication → Providers. The game shows
   the Google button automatically once it's on.
5. **Fill in the legal placeholders.** Replace `[CONTACT EMAIL]` and
   `[GOVERNING LAW]` in `client/src/content/legal/*.md`, and review the
   pages (they were drafted for you and are not legal advice).
6. **Get permission in writing** from NIKS GAMES LLC (what you may use, and
   any limits), and keep it with the project files.

## Updating the game

Database changes go in a new file in `supabase/migrations/` (never edit one
that's already deployed). Then:

```bash
SUPABASE_ACCESS_TOKEN=sbp_your_token NODE_USE_ENV_PROXY=1 node tools/deploy/supabase.mjs
```

Flags: `--seed` reloads city data and world settings, `--auth` re-applies
sign-in settings, `--keys` rewrites `client/.env.production`.

The website deploys itself when changes are merged to `main`.

## Tuning the economy

Most numbers live in tables, so you can change them live in the SQL editor:

- `game.config`: starting cash, offline cap, fees, tier thresholds, survey cost.
- `game.goods`, `game.menu_items`, `game.business_types`, `game.recipes`,
  `game.crops`, `game.fitout_items`: prices, rates, costs.
- `game.event_templates`: festivals and other events.

Example: `update game.config set value = 15000000 where key = 'tier2_net_worth';`

## Moderation

Staff see reports, the illegal-content queue, possible multi-accounts and
can start events from the 🛡️ Staff window. Every action needs a reason, which
the player sees. To add a word to the filter:
`insert into game.filter_words (word) values ('...');`

## Costs to expect

Free tiers cover early testing. Supabase's free plan pauses after a week
without activity and has a 500 MB database; move to the Pro plan before a
real launch. Map tiles come from OpenFreeMap (free); consider supporting it.

## Backups

Supabase Pro takes daily backups. On the free plan, export regularly with
`pg_dump` (Supabase → Project Settings → Database → connection string) and
keep the copy somewhere other than Supabase.
