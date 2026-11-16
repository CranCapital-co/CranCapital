# CranCapital build plan and status

Phases and gates from the design brief. ✅ done and tested, 🟡 done but
needs an owner action, ⬜ not started.

## Phase 1 · The map (front end)

- ✅ Real-world map of London, New York, Tokyo, Singapore; OSM credit always on screen
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
- ⬜ More cities (run tools/citydata with a new entry in cities.mjs, then deploy with --seed)
