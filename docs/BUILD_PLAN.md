# CranCapital build plan and status

Phases and gates from the design brief. ✅ done and tested, 🟡 done but
needs an owner action, ⬜ not started.

## Phase 1 · The map (front end)

- ✅ Real-world map of London, New York, Tokyo, Singapore and Paris; OSM credit always on screen
- ✅ Landing page with live stats and ticker; every window built (not mock-ups)
- ✅ Tutorial Island (works with no account and no server)
- ✅ Gate: map loads quickly on a phone (map engine loads only on the play screen; city data under 250 KB per city)

## Phase 2 · First business (Supabase)

- ✅ Sign-in (email link or code; Google once configured), 13+ check, profile, player number
- ✅ Buy a cart on a real street; menu, prices, hours, restock
- ✅ Per-minute tick, money ledger, offline earnings up to 24 h, "while you were away" card
- ✅ Gate: every dollar moves through the ledger; testers can't fake money (tests/db/economy.test.mjs + exploit regressions)
- 🟡 Custom SMTP needed before strangers can sign in (docs/SETUP.md)

## Phase 3 · Trade

- ✅ Order-book exchange with NPC market traders and a 1% fee; charts; ticker
- ✅ Shops and restaurants (rooms, fit-out, staff), land and buildings, mining and surveys, factories, ports and exports
- ✅ Gate: prices hold steady through a simulated test week (tests/db/market-week.test.mjs)

## Phase 4 · Social

- ✅ City, global and player chat; DMs; friends; Bug Reports and Suggestions boards; Discord directory
- ✅ Slur filter, link filter, block, reports, illegal-content form, staff actions with reasons
- ✅ Profiles, badges, net-worth rings, skins, titles, loyalty points, leaderboards, referral race, account page
- ✅ Gate: moderation tools work before chat opens (tests/db/social.test.mjs)

## Phase 5 · Launch

- ✅ Finance tier: city and player banks, loans, IPOs, shares, dividends; world events
- ✅ Legal pages, credits, wiki
- 🟡 Fill legal placeholders, written permission from NIKS GAMES LLC, Pages switched on, PR merged
- ✅ Fifth city (Paris) added after launch prep; more cities: add an entry to tools/citydata/cities.mjs, run it, add a migration for prices and wages, deploy with --seed

## Upgrade (docs/UPGRADE_BRIEF.md)

Turning the working economy into something you can see, hear and feel. All
six phases of the brief are built; every server test still passes, plus new
ones for each server addition.

| Phase | What it added | Server changes |
| --- | --- | --- |
| 1 · Interface | One SVG icon set (no emoji outside chat and names); HUD with tier ring, rolling cash, income rate, city/time/weather/event strip, sound and Empire view; five-button dock and a map-tools column; sheets (iPad side panel you can widen or swipe away, phone bottom sheet with three heights) with a back stack and camera padding; Web Audio sound with sliders; Graphics setting | None |
| 2 · 3D on the map | Three.js inside MapLibre (`client/src/world3d/`): one shared material, instancing, the player character with 14 outfits and seven animations, the food cart L1–3, instanced crowds from foot traffic and time of day, customers who walk up, queue and pay; detail by zoom; Auto graphics; `?debug` overlay; glTF overrides | None |
| 3 · The empire | A model for every business type (levels 1–5, closed/abandoned/depleted), shopfront dressing on real buildings, growing parts (floors, containers, crops), vehicles (traffic, taxi ride, delivery vans, ships), build show and level-up bounce, model pictures for icons and badges, the "peek inside" view | `map_businesses` returns crop, ore and your yard fill |
| 4 · Living city | Real sun (SunCalc) for models and buildings, sky, day-to-night street colours, lamps, headlights, glowing windows and your businesses glowing gold; real weather (rain, snow, cloud); visible world events; seasonal dressing | Weather table, Open-Meteo job via pg_net every 30 min, `city_weather()`; Graphics in prefs |
| 5 · Moments | Coins flying to the cash counter, stacking sale labels, first sale, tier-up (confetti, camera orbit, fanfare, card), badges, level-ups, leaderboard climbs, the coming-back fast-forward; Empire dashboard; new Business and Market windows; landing 3D hero, Tutorial Island in 3D with Pip, city dioramas, arrival swoop, finger cart preview | Daily net-worth snapshot and `net_worth_history()`, `my_income()`, `city_stats()` |
| 6 · More to do | Daily goals, contracts, city projects, shop decorations, street rivals, visiting an empire, photo mode | Goals, contracts, projects and decorations, with exploit tests |

Checks: `npm run test:db` (35 tests) and `npm run test:e2e` (Tutorial Island
in a browser: fails on any console error or if the 3D layer doesn't draw).
Real-device testing on a 9th-generation iPad is still to do: the frame-rate
budgets were checked only in a software-rendered browser here.

Assets to replace when ready: sounds (docs/SOUNDS.md) and Blender models
(docs/MODELS.md). Everything works without them.
