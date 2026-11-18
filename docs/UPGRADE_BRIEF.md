# CranCapital — Upgrade Brief

2026-11-18 · Harry Greenhalgh

This brief upgrades the CranCapital build in the CranCapital-co/CranCapital repo (17 Nov 2026). The economy underneath is solid and stays. Everything here is about turning it into something you can see, hear and feel. CranCapital is based on Capital Rift by NIKS GAMES LLC, used with their permission.

## Verdict on the current build

### Keep it: the hard part is done

- The server owns every dollar. Every change goes through `game.money()` into the ledger, and there are tests for exploits and for a simulated market week.
- All five cities, the per-minute tick, offline earnings, all six tiers, finance, chat and moderation already work.
- The touch sizing for iPad is thoughtful, and the map has a backup when tiles are blocked.

So almost all of this upgrade happens in `client/`. The server only gets a few small additions, listed in each section.

### Why it only feels alright

The game works, but you can't *see* it. It's a spreadsheet laid over a map.

| What you see now | Where it lives | Why it falls flat |
| --- | --- | --- |
| Every business is an emoji in a coloured circle | `map/icons.ts`, `businessIcon()` | All ten factory types, from flour mill to electronics plant, show the same 🏭. All three mines show ⛏️. Your empire never looks like an empire. |
| Players are flat discs with two dot eyes | `drawAvatar()` | No walking, no facing direction; skins are just colour swaps. |
| Crowds are 2–3 pixel dots | `map/crowd.ts` | They aren't linked to sales. Nobody ever walks up to your cart and buys something. |
| What you build on land doesn't appear | `GameMap.tsx`, businesses layer | An $80,000 apartment block is a badge on an empty plot. |
| A sale is a green text pop | `.sale-pop` in `app.css` | There's no sound anywhere in the client, and no coins or build-up. |
| No tier-up moment | nothing in `client/` | Reaching Finance feels the same as restocking lettuce. |
| Night is a blue tint | `.night` overlay | Windows don't light up, and there are no street lamps. |
| Icons are system emoji | dock, buttons, window titles | They look different on every device and read as placeholders. |
| The game lives in windows | 8–9 dock buttons, side panels | The map is a backdrop; all the fun is in tables. |

Small bug while you're there: the landing page's “Your real world” line lists four cities and leaves out Paris (`screens/Landing.tsx`, `PILLARS`).

### The goal in one line

**Make the economy visible.** Every number in the database should have something on the map you can watch move: customers walking up, coins flying, buildings growing, lights coming on.

## The new look: a living toy city

The real map stays, but it becomes a miniature model of the city: a tabletop diorama lit by afternoon sun, full of tiny people doing business. It should feel cosy, busy and satisfying. For feel only (not to copy), look at Mini Motorways, Townscaper, Pocket City and Two Point Hospital.

### Five pillars

- **See the money.** Every sale is a person at your counter. Every payment is a coin you can watch fly.
- **Your empire is physical.** Every business type has its own 3D model, and it visibly grows when you level it up.
- **The city breathes.** Real local time, real sun, real weather, crowds that rise and fall through the day.
- **Every tap answers.** Sound, motion or both within a tenth of a second.
- **Smooth on iPad.** Aim for 60 frames a second; drop detail before dropping frames.

### Look and feel

| Element | Direction |
| --- | --- |
| Shapes | Chunky low-poly, rounded edges, flat colours with soft shading. People and props are about three times real scale so they read at street zoom. |
| Colour | Keep the cream land, deep green brand and gold. Each tier keeps its hue from `BUSINESS_COLORS` (coral, green, olive, brown, steel blue, purple). **Gold trim always means “yours”**; other players' businesses never use it. |
| Real buildings | Keep the OpenStreetMap 3D buildings, but warmer: lighter roofs than walls and a soft darker band at street level. |
| Light | One warm sun placed where the real sun is in that city right now. Soft shadows under every model. |
| Camera | On foot: tilted about 55°, close in, easing to follow you as you walk. An **Empire view** button lifts the camera to show everything you own in the city. Short camera flights for big moments. |
| Type | Keep Fraunces for headings and Inter for everything else. Money always uses even-width digits so it doesn't jiggle while counting. |
| Sound | Warm and wooden: soft clicks, cash-register dings, coins, a gentle city hum. Never shrill. |

## Models

This is the biggest change: real 3D models on the real map.

### How 3D gets onto the map

- Add **Three.js** and draw it *inside* MapLibre as a custom layer, so the map and the models share one camera and one canvas. Put it all in a new folder, `client/src/world3d/`, with one `WorldLayer` class that owns the scene, lights, model cache and instancing.
- Models are **glTF (.glb)** files, compressed with gltf-transform (meshopt), coloured from **one shared palette texture**. Every model then uses the same material, which keeps iPad draw calls low.
- Models are loaded only when they're first needed, and cached in the browser.

### Where the models come from

| Source | Use it for |
| --- | --- |
| **Kenney city kits** (Roads, Suburban, Commercial, Industrial) | Street props, trees, cars, trucks, fences, lamp posts. They're CC0: free, commercial use allowed, glTF included. Credit is optional, but add it to Credits anyway. |
| **Made for CranCapital** (in Blender, low-poly) | Anything that is uniquely ours: the player character, carts, every business model below. |
| **Built in code from parts** | Things that grow: apartment towers gain floors, yards stack containers, farms fill with crop rows. |

### The player character

- One new character for everyone: a chunky little business person of about 800 triangles, rigged on one shared skeleton.
- Animations: idle, walk, run, wave, cheer, sit and “checking phone”. They face the way they walk, and the walk speed matches `WALK_SPEED`.
- The 14 existing skins become **outfits**, keeping their ids so nobody loses one. For example: hardhat gets a hi-vis vest and hard hat, captain a sailor cap, graduate a mortarboard, tycoon a top hat and gold watch, gilded a gold suit.
- The net-worth ring becomes a **glowing ring on the ground** under the character (`double` style = two rings). The name tag floats above, as now.
- Other players glide smoothly between their position updates instead of jumping.

### Customers and crowds

- Replace the dots with **instanced low-poly people**: 5–6 body shapes in many colours, about 150 triangles each, with a cheap walking bob done on the graphics card. Up to about 300 on screen on High.
- Crowd density comes from the city's real foot-traffic data (`traffic.bin`) and the hour of day, not from how many streets are on screen.
- **Customers you can see buy.** When a `sales` event arrives for one of your businesses, nearby walkers turn toward it, queue, pay (coin pop and ding) and walk off carrying a cup or bag. Show up to six customers per sale event. Other players' businesses get background customers based on their level, so no private sales numbers leak.

### Business models

Every business type gets its own silhouette and **grows visibly with level**. Closed, abandoned or depleted businesses look it: shutters down, weeds, a stopped wheel.

| Business | Model | Grows with level | Moves |
| --- | --- | --- | --- |
| Food cart | Handcart with a striped awning in tier colour and a little menu board | Level 2 gets a parasol and stool; level 3 becomes a food truck | Steam when cooking; vendor waves at each sale |
| Café, restaurant, grocery | Shopfront dressing added to the real building: awning, sign with the business name, outdoor tables or crates | More tables, planters, a bigger sign | Steam from cups; string lights at night |
| Furniture and electronics stores | Shopfront with a sofa or glowing screens in the window | Delivery van parked outside | Screens flicker |
| Bank | Stone columns and gold lettering added to the building front | Taller columns, flags | Doors open for customers |
| Farm | Crop rows filling the plot, coloured by crop, barn and silo | More rows, second silo, tractor | Crops grow from soil to ripe each cycle; tractor drives the rows |
| Tree farm | Rows of saplings | Denser rows | Trees grow, get cut, get replanted |
| Storage yard | Fenced yard with shipping containers | Containers stack higher as **your storage fills** | Forklift shuffles boxes |
| Apartment block | Tower built from parts on the plot | +2 floors per level, balconies | Windows light up at night, more when it's full |
| Coal, iron and copper mines | Headframe tower with a wheel and ore carts; spoil heap coloured by ore | Taller headframe, more carts | Wheel turns while it produces |
| Quarry and sand pit | Stepped pit or sand mound with a digger | Deeper pit, bigger mound | Digger works |
| Oil well | Nodding pumpjack | More pumpjacks | Nods while producing |
| The ten factories | Each one distinct: mill with turning sails, steel mill with glowing furnace, refinery with tanks and a flare, sawmill with log piles, glassworks with a hot glow, and so on | Bigger halls, more chimneys | Smoke or steam only while running |
| Port | Quay with a container crane | More cranes, longer quay | A ship sails off when an export leaves, and comes back empty |

**Peek inside.** Shops already have a fit-out grid (counter, coffee machine, shelving, chiller, plants, art, lighting, vault). Draw it as a small 3D cutaway room at the top of the Business window, so fitting out a shop feels like decorating it.

### Vehicles

- Ambient cars and buses on main roads, using the traffic data.
- When you take a taxi, a taxi pulls up and drives off with you.
- Vans drive from your storage to your businesses when goods move, and ships carry exports out of ports.

### Detail by zoom

| Zoom | What draws |
| --- | --- |
| 16 and closer | Full models, people, vehicles, animations |
| 14.5–16 | Simpler models, no people |
| Further out | Badges, redrawn with the new icon set |

**Icons made from models.** Render each business model once into a small picture and cache it. Use that picture in badges, the Build menu and windows, so the steel mill's icon *is* the steel mill.

## The living city

### Real sun, real sky

- Work out the sun's direction and height for the city's location and local time (the small SunCalc library does this). Use it to place the Three.js sunlight *and* MapLibre's own light, so models and real buildings cast light the same way.
- Light colour follows the day: crisp morning, warm golden hour, blue dusk, deep navy night.
- Add a sky that changes colour through the day. MapLibre has supported a sky since version 4.5, and the game is already on 4.7, so nothing new to install. (Its fog needs 3D terrain, so leave fog out.)
- Delete the blue `.night` overlay: real lighting replaces it.

### Night

- Street lamps glow along main roads, car headlights and tail lights come on, shop signs and windows light up.
- **Your businesses glow gold at night**, so you can spot your empire from across the city.

### Real weather

- Get each city's current weather from **Open-Meteo**. It's free for non-commercial use with no key, allows up to 10,000 calls a day, and its data is CC BY 4.0, so add it to Credits.
- Fetch it **on the server**, not in each player's browser: one scheduled job every 30 minutes saves the weather for all five cities into a table, and clients read that. (Five cities every 30 minutes is 240 calls a day.)
- What it looks like: rain (falling streaks, darker light, shiny streets, umbrellas), snow (flakes, white tops on models), cloud and fog (flatter, dimmer light).
- Later, swap the random “Rainy week” and “Heatwave” world events for real weather, using the demand changes they already have.
- If you ever charge real money, Open-Meteo needs a paid licence.

### Make world events visible

The server already runs world events. Each one should change the street, not just a number:

| Event | On the map |
| --- | --- |
| Street festival | Bunting between lamp posts, stalls, much thicker crowds |
| Heatwave | Heat shimmer, people in shorts, ice-cream queues |
| Rainy week | Rain and umbrellas, people hurrying indoors |
| Transit strike | Quiet streets, crowds at bus stops |
| Restaurant week | Banners on restaurant fronts, full outdoor tables |
| Big sale weekend | SALE banners on stores, people carrying bags |
| City marathon | Runners streaming along a route lined with barriers and spectators |

## Game feel

### Sound (there is none today)

- One small sound manager in `client/src/audio/` using Web Audio. Short MP3 files, which play in every browser.
- On iPad, audio can't start until the first tap, so unlock it on the first touch.
- **Effects:** button tap, window open and close, sale ding (pitch rises with the amount; quick sales roll into a “cha-ching”), coins landing in the cash counter, construction hammering, level-up chime, tier-up fanfare, notification chime, chat pop, market buy and sell clicks, a soft thud for errors.
- **Ambience per city:** traffic and birds by day, a quiet hum at night, rain when it's raining. It fades as you zoom out.
- **Settings:** a mute button in the HUD, plus Master, Effects and Ambience sliders in Account.
- Sources: CC0 sound packs (Kenney publishes some) or Freesound filtered to CC0, or record your own.
- No vibration: iPads have no vibration motor and Safari doesn't support the web vibration feature, so sound and motion carry all the feedback.

### Money you can feel

- The cash in the HUD **rolls up** smoothly instead of jumping.
- When a sale lands on a business you can see, **coins fly** from it to the cash counter. Off-screen sales just roll the counter.
- Floating “+$12.50” labels stack and merge above the business; big sales are bigger and gold.
- Under the cash, show your **income rate** (“+$1,240 an hour”), worked out from the last hour of sales.

### Building things

- Placing anything plays a two-second build: scaffolding and a little crane rise, hammering, then the model pops up with a puff of dust. The server timing doesn't change; this is just the show.
- Levelling up makes the model grow with a bounce as its new parts drop in.

### Big moments

| Moment | What happens |
| --- | --- |
| First sale ever | Camera eases to the cart, a customer buys, coin flies, a “First sale!” card |
| Business levels up | It grows on the map, with a chime |
| **New tier** | Screen dims, the camera circles your empire, fanfare, confetti in the tier's colour. A card shows the tier's name, its one new idea (already in the tiers table) and what you can now build, with a **Build one** button. |
| Badge earned | The badge flips in from the top |
| Leaderboard climb | “You're now #12 in London” |
| Export leaves port | Ship's horn, the ship sails out |
| Coming back | “While you were away” starts with a 3-second fast-forward of the city (sun sweeps across, counters roll), then shows the summary card |

### Motion rules

- Springy easing, not straight lines. Interface movements take 150–250 ms; camera moves 0.6–1.2 seconds.
- A tap always skips a celebration; nothing ever blocks play.
- Respect the device's Reduce Motion setting in the JavaScript animations and camera flights too, not just in the CSS (which already does it).

## UI overhaul

### One icon set, no emoji

- Replace every emoji in the interface with **one custom SVG icon set**: 24-point grid, rounded 2-point strokes, a filled accent in the tier colour. One `<Icon>` component reading from a single sprite file.
- About 60 interface icons (dock, map buttons, window titles, actions) and one small illustrated icon per good on the exchange.
- Business icons come from the 3D model renders (see Models).
- Emoji stay only where players type them: chat, names and business names.

### HUD

| Area | What it shows |
| --- | --- |
| Left | Your avatar inside a **tier progress ring** (replacing the separate bar); cash with rolling digits; income rate underneath; tap for net worth |
| Middle (iPad landscape) | City, local time, weather and temperature, and a chip for any world event that's on |
| Right | Notifications, sound on/off, Empire view |

### Dock: nine buttons down to five

| Button | What's inside |
| --- | --- |
| **Build** | The build menu, now with model pictures and “you can afford this” markers |
| **Empire** | New dashboard, plus tabs for Businesses, Storage and Bank |
| **Market** | The exchange |
| **People** | Chat, friends and boards, plus Leaderboards |
| **More** | Help, Account, and Staff for staff |

The four map buttons on the right (Find me, Land, Heat map, Taxi) fold into one expandable map-tools column with the new icons.

### Windows become sheets

- **iPad:** the panel still slides in from the right, but it has a drag handle to switch between narrow and wide, and a swipe closes it.
- **Phones:** a bottom sheet with three heights (peek, half, full). The map stays usable while it's peeking.
- Opening a business **flies the camera to it** and keeps it framed beside the panel, using MapLibre's camera padding so the panel never covers it.
- Windows keep a back stack: business → a good on the market → back to the business.
- Tapping a notification flies you to whatever it's about.

### Empire dashboard (new)

- Net worth over the last 7 and 30 days as a line chart. This needs a daily net-worth snapshot on the server if one isn't stored yet.
- Income by business, best to worst, as a bar list.
- **Needs attention** with one-tap fixes, such as **Restock all** (calling the existing restock action for each business) or Reopen.
- Today's goals (see New things to do).

### Business window

- At the top: a live 3D view of the business, or the interior cutaway for shops.
- Big number tiles: sales today, profit per hour, and **time until stock runs out** (“Lettuce runs out in about 40 min”).
- The main button changes to whatever matters most right now: Restock, Reopen, Hire or Upgrade.
- When you change a price, the demand meter shows the expected customers per hour.

### Market window

- A proper price chart with 1-hour, 24-hour and 7-day ranges.
- The order book drawn as depth bars.
- Buy and sell with a quantity slider and a clear total that includes the 1% fee.

### Polish

- Rounder 20-point panels, softer layered shadows, the existing glass blur.
- Gains show green with ▲ and losses red with ▼, so colour is never the only signal.
- Check every new colour in both light and dark mode.
- Keep the current 44-point tap targets and button labels for screen readers.

## The first five minutes

This is where players decide to stay. Script it like a film.

| When | What the player sees |
| --- | --- |
| **Landing page** | The hero image becomes a live 3D view slowly circling a real street, with carts, walkers and real players' businesses. If WebGL or the map tiles fail, show the current drawing instead. Keep the live stats and price ticker, and add Paris to the city list. |
| **Sign in** | As now: email link or code. |
| **Tutorial Island** | Rebuilt with the new models and sounds. A guide character (say, a cart vendor called Pip) talks in short speech bubbles. Still about three minutes. |
| **Pick a city** | Each card shows a small 3D diorama of a street in that city, its local time, today's weather and how many players are online there. |
| **Arrival** | The camera starts high above the city, looking straight down, and swoops to street level in about three seconds while the city name appears. |
| **First cart** | The Build button glows. In placing mode, the parkable streets shimmer green and the cart follows your finger while you press (today the preview only works with a mouse). Show foot traffic as **Quiet, Busy or Packed** with stars, and the exact number underneath. |
| **Waiting for the first sale** | Walkers already slow down and read your menu board, so the street feels alive before the next tick. |
| **First sale** | The full first-sale moment from Game feel. |
| **Next** | Three starter goals appear: sell 10 meals, earn $500, change a price. |

## New things to do

The economy is deep already; what's missing is a reason to open the game *today*. Add these last, after it looks and sounds right.

| Feature | What it is | Server change |
| --- | --- | --- |
| **Daily goals** | Three small goals a day (sell 50 meals, make a trade, upgrade something) that pay loyalty points | Small: goals table, progress checked in the tick |
| **Contracts** | Orders from the city: “A hotel near Trafalgar Square wants 400 side salads by 6 pm.” Deliver from storage for a bonus above market price; miss it and lose the deposit. | Medium: contracts table, accept and deliver actions that go through the ledger |
| **City projects** | Everyone in a city chips in goods toward something big, like a new market hall. When it's done, a 3D landmark appears and nearby foot traffic rises for good. | Medium: project table, contributions through the ledger |
| **Street rivals** | When another player's cart nearby sells the same dish, both carts show a little rival flag and a friendly price comparison | None: uses map data the client already has |
| **Shop decorations** | Awning patterns, sign styles, neon, flower boxes and lights for your businesses, bought with loyalty points. Looks only, never power. | Small: cosmetics owned per business |
| **Visit an empire** | Tap a player, choose **Visit**, and the camera tours their businesses one by one | None |
| **Photo mode** | Hide the interface, move the camera freely, slide the time of day, add a filter, save a picture | None |
| **Seasonal dressing** | Winter market stalls and lights in December, and so on | Small: date-based flags |

## Performance and quality bar

All of this must still run smoothly on a school iPad. Test on the cheapest iPad you can get hold of (a 9th-generation iPad is a good benchmark), not just a new one.

### Budgets

| What | Target |
| --- | --- |
| Frame rate | 60 a second on Medium on the test iPad; never below 30 |
| Triangles on screen | High 250k · Medium 120k · Battery saver 50k |
| Draw calls from the 3D layer | Under 100 (instancing plus the one shared material) |
| Model downloads | Under 2 MB for what one city needs at street level; under 8 MB for every model, loaded only when needed |
| Sound | Under 1.5 MB in total; ambience loads after the first tap |
| Three.js | Roughly 150–200 KB extra once compressed. Load it only on the play screen, like MapLibre already is. |
| Memory | Under about 400 MB, because Safari closes tabs that use too much |
| Start-up | Play screen usable within 4 seconds on a good connection |

### Quality settings

Add a Graphics setting in Account: **Auto** (the default), High, Medium and Battery saver.

| Setting | Shadows | People on screen | Traffic | Sharpness | Weather effects |
| --- | --- | --- | --- | --- | --- |
| High | Real shadows | Up to 300 | Full | Full (pixel ratio up to 2) | Yes |
| Medium | Soft blobs | Up to 150 | Light | Pixel ratio 1.5 | Yes |
| Battery saver | None | Up to 50 | None | Pixel ratio 1, capped at 30 frames a second | No |

**Auto** watches the frame rate: if it stays under 45 for five seconds it steps down one level, and if it stays over 58 for 30 seconds it steps back up. Stop drawing completely when the tab is hidden.

### Checks

- A debug overlay behind `?debug` showing frame rate, draw calls, triangles and memory.
- A browser test that opens Tutorial Island (it needs no server) and fails if anything errors in the console or the 3D layer doesn't draw.
- Keep every existing server test passing; this upgrade shouldn't break any of them.

## Build order

The interface comes first because players touch it every second. The 3D world comes next because it's the biggest jump. New features come last, once the game already looks and sounds right.

## Prompts for Claude Code

**Before you start:** put this brief in the repo as `docs/UPGRADE_BRIEF.md`. Then use one new Claude Code session per phase. Merge each pull request and play it on your iPad before starting the next. If a phase is too big for one session, ask Claude Code to split it and do the first half.

### Phase 1 · Interface

```text
Read docs/UPGRADE_BRIEF.md and docs/BUILD_PLAN.md. Do Phase 1 (Interface) only:
- Replace every emoji in the interface with one custom SVG icon set and an <Icon> component. Keep emoji only in chat and player-typed names.
- Rebuild the HUD: tier progress ring around the avatar, rolling cash, income rate, a city/time/weather/event strip, and a mute button.
- Cut the dock to five buttons (Build, Empire, Market, People, More) as the brief describes, and fold the four map buttons into one map-tools column.
- Turn windows into sheets (iPad: resizable side panel, swipe to close; phones: three-height bottom sheet) with a back stack. Fly the camera to a business when its window opens, using camera padding so the panel never covers it.
- Add client/src/audio/ with a Web Audio sound manager, unlocked on the first tap, with the effects listed in the brief and Master/Effects/Ambience sliders in Account. If you can't get CC0 sound files, make placeholder sounds with Web Audio and list the files I should replace.
- Add the Graphics setting (Auto, High, Medium, Battery saver) to Account and save it in prefs.
- Fix the landing page so the city list includes Paris.
Don't change anything in supabase/. Keep every existing test passing. Check light and dark mode on an iPad-sized screen. Add an "Upgrade" section to docs/BUILD_PLAN.md, then open a pull request.
```

### Phase 2 · 3D on the map

```text
Read docs/UPGRADE_BRIEF.md. Do Phase 2 (3D on the map):
- Add three to the client. Create client/src/world3d/ with a WorldLayer that draws Three.js inside MapLibre as a custom layer sharing its camera. Load it only on the play screen.
- One shared palette-texture material, glTF loading with meshopt, a model cache and instancing.
- The player character: one rigged low-poly character with idle, walk, run, wave, cheer, sit and phone animations; the 14 skins as outfits keeping their ids; the net-worth ring on the ground; other players gliding between updates. If you can't make a good model in code, build a clean placeholder from simple shapes and write docs/MODELS.md listing every model I need to make in Blender, with size, triangle budget, pivot point and animation names.
- The food cart model at levels 1 to 3.
- Replace the crowd dots with instanced people, with density from traffic.bin and the time of day.
- Customers who walk up, queue and pay when a sales event arrives.
- Detail by zoom as in the brief, keeping badges for far zoom.
- Follow the Graphics setting and add the ?debug overlay.
Stay inside the performance budgets on an iPad-sized window. Update docs/BUILD_PLAN.md and open a pull request.
```

### Phase 3 · The empire

```text
Read docs/UPGRADE_BRIEF.md. Do Phase 3 (The empire):
- A model for every business type in the catalog migration, following the Business models table: levels 1 to 5 look clearly different, and closed, abandoned and depleted states show.
- Plot businesses stand on their plot; room businesses add shopfront dressing to their real building.
- Build the growing parts in code: apartment floors, containers stacked by storage fill, crop rows by crop.
- The 3D "Peek inside" cutaway from the fit-out grid at the top of the Business window.
- Vehicles: background traffic, the taxi ride, delivery vans on restock, ships for exports.
- The two-second build animation and the level-up grow.
- Render each model once into a cached thumbnail and use it in badges, the Build menu and windows.
Add Kenney (CC0) to Credits if you use their kits. Update docs/BUILD_PLAN.md and open a pull request.
```

### Phase 4 · Living city

```text
Read docs/UPGRADE_BRIEF.md. Do Phase 4 (Living city):
- Sun position (SunCalc) for each city's location and local time drives both the Three.js light and MapLibre's light; light colour changes through the day; add MapLibre's sky; delete the .night overlay.
- Night: street lamps, headlights, lit windows and signs; the player's own businesses glow gold.
- Weather: a new migration with a city weather table, a job every 30 minutes that fetches each city's current weather from Open-Meteo on the server (pg_net or an Edge Function, whichever fits this setup; never from the browser), and a read function for the client. Add Open-Meteo (CC BY 4.0) to Credits. Draw rain, snow and cloud.
- Make each world event visible as the brief's table describes.
- Seasonal dressing behind date flags.
The weather job must never touch money or the ledger. Add tests for the weather table and read function. Update docs/BUILD_PLAN.md and open a pull request.
```

### Phase 5 · Moments

```text
Read docs/UPGRADE_BRIEF.md. Do Phase 5 (Moments):
- Money motion: rolling cash, flying coins, stacking floating labels, income rate.
- Every row of the Big moments table: first sale, level up, tier up (camera circles the player's businesses, confetti, tier card with a Build one button), badge, leaderboard climb, export horn, and the "while you were away" fast-forward.
- The Empire dashboard (add a daily net-worth snapshot on the server if there isn't one, with a test), plus the new Business and Market windows.
- The first five minutes: 3D landing hero with the old drawing as fallback, Tutorial Island rebuilt with the guide character, city cards with dioramas, the arrival fly-in, a touch preview when placing a cart, and Quiet/Busy/Packed foot-traffic labels.
Every animation follows Reduce Motion and can be skipped with a tap. Update docs/BUILD_PLAN.md and open a pull request.
```

### Phase 6 · More to do

```text
Read docs/UPGRADE_BRIEF.md. Do Phase 6 (More to do), one feature per commit, server side first:
- Daily goals, contracts, city projects and shop decorations (bought with loyalty points, looks only). New migrations where every money or goods change goes through game.money() and the ledger, with tests in tests/db/ including exploit tests.
- Street rivals, Visit an empire and Photo mode (client only).
Add a wiki page in client/src/content/wiki for each feature, update docs/BUILD_PLAN.md and open a pull request.
```

## What not to change

- **The money rules.** The client only asks; every change to cash or goods goes through `game.money()` and lands in the ledger. Animations are only a show: coins fly *after* the server confirms, never before.
- **No pay-to-win.** Decorations and outfits are looks only. Game money still can't be bought.
- **The map backup.** Keep the simple street map that appears when tiles are blocked, and make sure the 3D layer still draws on top of it.
- **Credits.** Keep the NIKS GAMES LLC line and the OpenStreetMap credit always on screen, and add Kenney and Open-Meteo if you use them.
- **Tutorial Island works with no account and no server.** Keep it that way: it's the safest way to test the 3D layer.
- **The server tests.** Every test in `tests/db/` keeps passing after every phase.

