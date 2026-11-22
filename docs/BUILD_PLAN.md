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

Checks: `npm run test:db` (46 tests) and `npm run test:e2e` (Tutorial Island
and a new player's first minutes with Nations and Renown, in a browser: fails
on any console error or if the 3D layer doesn't draw).
Real-device testing on a 9th-generation iPad is still to do: the frame-rate
budgets were checked only in a software-rendered browser here.

Assets to replace when ready: sounds (docs/SOUNDS.md) and Blender models
(docs/MODELS.md). Everything works without them.

## Phase 2 of the upgrade: Renown and Nations

Design and research: docs/PROGRESSION_AND_NATIONS.md.

| Part | What it added | Where |
| --- | --- | --- |
| Renown | XP from everything (sales are log-scaled), a fast early level curve with no cap, a rank every 5 levels, unlocks by level, perks in five branches, supply/gold/war crates with a pity counter, a daily reward that never resets plus streak shields, daily and weekly missions, 22 tiered achievements, a free 40-tier monthly season, titles; HUD badge, XP floats, level-up card, Renown window | `20261122000100_renown.sql`, `ui/RenownMoments.tsx`, `ui/panels/ProgressWindow.tsx` |
| Country selection | 175 real countries; first come, first served (row lock + unique leader); claiming resets the country and returns land it held; 24 h new-leader protection; stepping down; inactive leaders hand back to the AI; picker on first load | `20261122000200_nations.sql`, `nations/NationPicker.tsx` |
| National economy | Taxes from GDP, tax rate, research and infrastructure budgets, manpower from population, stability, war exhaustion, upkeep and desertion, invest business cash, leader's stipend | `20261122000200_nations.sql` |
| Military | 8 building types with levels, 6 unit types, training queues, 21 technologies, Renown and research gates | `20261122000200_nations.sql`, `nations/NationTabs.tsx` |
| War and diplomacy | Declarations with infamy, defensive alliances that join automatically, movement along land and sea links (air 2,500 km, missiles 3,000 km), Lanchester battles with forts, militia, air defence and sea crossings, occupation, war score, peace terms, surrender, capitulation, truces, pacts, envoys, denunciations, revolts | `20261122000300_war.sql`, `nations/NationsScreen.tsx` |
| AI nations | Skill 1–5 and six personalities; same rules and costs as players; threat assessment, budgets, research choice, recruiting, building, deployment, attacks by estimated odds, denounce-then-declare, peace by score and exhaustion, alliances, pacts | `20261122000400_ai.sql` |
| World domination | Power index, domination share, 50% wins the era (else the top power after 90 days), Hall of Fame, new era resets the map | `20261122000300_war.sql` |

Tests: `tests/db/renown.test.mjs`, `tests/db/nations.test.mjs`, `tests/e2e/nations.test.mjs`.

