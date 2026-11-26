# CranCapital

A browser business-tycoon game on a real-world map that every player shares.
Start with one food cart on a real street in one of 14 cities (London, New York,
Tokyo, Paris, Rio de Janeiro, Mumbai and more), and grow it into shops, land,
mines, factories, ports and a bank.
Businesses keep earning while you're offline (for up to 24 hours).

Every player also leads a real country in one shared world: build an army,
research technology, make alliances, go to war and aim for world domination.
Countries without a player are run by AI governments. A Renown level, with
ranks, perks, crates, missions, achievements and a free monthly season,
rewards everything you do.

Made for iPad: everything is sized for fingers, and "Add to Home Screen" in
Safari opens the game full screen. It also works in any modern browser.

CranCapital is based on Capital Rift by NIKS GAMES LLC, used with their permission.

- Play: https://crancapital-co.github.io/CranCapital/
- Tutorial Island (no account): https://crancapital-co.github.io/CranCapital/#/tutorial

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Game client | `client/` (Vite, React, TypeScript, MapLibre) | Static site on GitHub Pages. Map, windows, Tutorial Island. Only ever *asks* the server. |
| Game server | `supabase/migrations/` (Postgres on Supabase) | Owns all money, goods and property. Every action is a database function that checks the rules and writes the money ledger. |
| Economy tick | `game.tick()` via pg_cron, every minute | Sales, production, rent, wages, loans, market traders, offline cap. |
| Live updates | Supabase Realtime | Notifications and chat. |
| City data | `tools/citydata/` → `supabase/seed/cities/`, `client/public/cities/` | Buildings, foot traffic, buildable plots and port sites, built from OpenStreetMap via OpenFreeMap tiles. |
| Map tiles | OpenFreeMap (free, no key), built into `client/public/tiles/` by `tools/citydata/tiles.mjs` | Real streets and 3D buildings, served with the site so they load on networks that block map servers. |
| 3D world | `client/src/world3d/` (Three.js inside MapLibre) | People, businesses, vehicles, weather and the living city, all built in code. |
| Weather | Open-Meteo, fetched by the server every 30 minutes | Rain, snow and cloud on the map. |
| Nations | `game.world_tick()` via pg_cron, every minute | National economies, training, construction, armies and battles, wars and peace, AI governments, world domination. |
| Renown | `game.renown_tick()` via pg_cron, every minute | XP from the business game, achievements. |
| World data | `tools/world/build.mjs` → `supabase/migrations/20261122000500_world_data.sql`, `client/public/world/` | 175 countries from Natural Earth with population, GDP, land and sea links. |

Rules the server keeps: the client only asks; every change to a player's cash
goes through `game.money()` and lands in `game.ledger`; players can't reach
any table directly (schema `game` isn't exposed and has row-level security);
actions are rate limited; nobody can teleport.

## Repository map

```
client/                 the game website
  src/screens/          landing, play, world, tutorial, wiki/legal pages
  src/ui/panels/        one file per game window
  src/map/              map style, crowds, icons
  src/content/          wiki and legal pages (Markdown)
supabase/migrations/    the whole game server, in order
supabase/seed/          city data, word filter, world settings
tools/citydata/         rebuild city data from map tiles
tools/world/            rebuild the world map for Nations (Natural Earth)
client/src/nations/     country picker, world map and the nation screen
tools/local-supabase/   a local Supabase-compatible stack for testing (Linux)
tools/deploy/           push the database to the hosted Supabase project
tests/db/               end-to-end tests through the real API
docs/                   setup guide and build plan
```

## Run it locally (Linux)

Needs Node 22, Docker, `postgresql-16` and `postgresql-16-cron`.

```bash
npm install
```

```bash
tools/local-supabase/start.sh
```

```bash
tools/db/apply-local.sh
```

```bash
npm run dev
```

Open http://localhost:5173. Local sign-in skips email (any address works).

Run the tests (needs the local stack running):

```bash
npm run test:db
```

The browser test opens Tutorial Island and fails on any console error or if
the 3D layer doesn't draw (needs `npm run dev` running and Playwright's
Chromium):

```bash
npm run test:e2e
```

## Deploy

See [docs/SETUP.md](docs/SETUP.md). In short: `node tools/deploy/supabase.mjs`
updates the database, and pushing to `main` publishes the site.

## Licences and credits

- Map data © OpenStreetMap contributors, available under the Open Database
  License (ODbL 1.0). The derived city data in `supabase/seed/cities/` and
  `client/public/cities/` is also available under the ODbL.
- Map tiles by OpenFreeMap, using the OpenMapTiles schema.
- Open-source libraries: MapLibre GL JS (BSD-3-Clause), React, Supabase JS,
  Zustand, Marked and Vite (MIT). Fonts: Fraunces and Inter (SIL OFL 1.1).
- Full credits are in the game at `#/legal/credits`.
