# Renown and Nations: design

Phase 2 adds two new systems on top of the business game:

1. **Renown**: a new levelling system with XP, levels, ranks, perks, crates, achievements, missions, a daily streak and a free monthly season track.
2. **Nations**: every player leads a real country in one shared world. Countries without a human leader are run by AI. Countries build militaries, research technology, make alliances, go to war, take territory and compete for world domination.

The two systems feed each other:

- Business profits can be invested in your nation.
- Your nation pays you a leader's stipend.
- Renown perks boost both your businesses and your armies.
- Military actions earn Renown XP.
- Renown levels unlock military capabilities.

Everything runs on the server, in Postgres, like the rest of the game. The client only shows the state and asks the server to act.

## What the research says

The sources are listed at the end.

**Progression**

- The level curve sets the pace. XP needed per level should rise a little faster than XP income, so levels never stop coming but later ones take longer.
- Reward frequency is where most systems fail. Rewards that come too often feel meaningless. If they come too rarely, players quit before the payoff.
- Short plateaus are fine when something visible is approaching.
- Motivation rises as a goal gets closer (the goal-gradient effect). It also rises when progress starts above zero (the endowed-progress effect). So every goal shows a progress bar, and the next unlock is always on screen.
- Random rewards make progress feel smoother than fixed ones. They also feel like gambling when money is involved. Our crates contain only game rewards, are never sold, and have a pity counter: every tenth crate is guaranteed rare.
- Punitive streaks cause anxiety. Warframe replaced its streak with a cumulative count. Our daily reward advances on total days played, never resets, and streak shields cover missed days.
- Battle passes are seen as the fairest retention device because rewards are visible in advance. The criticism is that paid tiers create fear of missing out. Our season track is free and has no paid tier.
- Players have different motivations, so there are several parallel tracks: levels, perks, achievements, missions, the season and world power.

**Strategy and AI**

- Paradox-style wars run on war score, war exhaustion and negotiated peace. Occupation drives exhaustion and score, and losers accept terms that match the score.
- Civilization-style diplomacy runs on visible plus and minus factors toward each nation.
- Personalities make AI readable. Galactic Civilizations' AI reacts to broken treaties, strong militaries and picking on the weak.
- Players dislike AI that cheats or acts at random. Difficulty should come from better decisions, not bonuses.
- Browser games such as Supremacy 1914 fill empty countries with AI, keep the map persistent for weeks, and reward diplomacy over raw force.
- Combat uses a Lanchester square-law model: fighting strength grows with the square of numbers, times quality. Terrain and forts are added as modifiers.

## Renown

| Part | How it works |
| --- | --- |
| XP | Earned from almost everything: sales (log-scaled, so rich players don't run away with it), trades, building and upgrading, contracts, city projects, travel, daily rewards, missions, achievements, recruiting, construction, research, battles, conquests, alliances and peace. |
| Level curve | XP to the next level is `100 + 35(L-1) + 2(L-1)^1.6`. That is 100 XP for level 2, about 480 for level 11 and about 2,800 for level 51. Levels 1–5 take about 20 minutes. There is no level cap. |
| Ranks | A new rank every 5 levels: Recruit, Hustler, Trader, Merchant, Magnate, Tycoon, Mogul, Baron, Titan, Sovereign, Emperor, then Legend I, II and so on every 10 levels. A rank-up gives a gold crate and a title. |
| Unlocks | Research at level 3, artillery at 4, armour and declaring war at 5, alliances at 6, air forces at 10, navy at 12, missiles at 20. |
| Perks | 1 perk point per level. Five branches with five ranks each; rank *r* costs *r* points. **Trade**: +2% sales per rank, paid as a bonus. **Fortune**: +5% XP and better crates. **Command**: +4% army strength and −4% recruit cost. **Statecraft**: +5% national income and research. **Logistics**: +6% army speed and −5% upkeep. One free respec a week; more cost a respec token. |
| Crates | A supply crate each level, a gold crate each rank, war crates for victories. Opening one picks a reward on the server: cash, loyalty points, XP, research, troops, war funds, XP boosts or respec tokens. Values scale with level. Every tenth supply crate is guaranteed gold. |
| Daily reward | Claim once a day. The reward climbs over a 7-day cycle (a crate on day 3 and a gold crate on day 7). The cycle advances on days claimed, so it never resets. Consecutive days build a streak, and a streak shield (one earned per 7 days, up to 2) covers a missed day. |
| Missions | 3 daily and 3 weekly missions, drawn from what you actually do, including nation missions once you lead a country. Each pays XP. |
| Achievements | 22 tracks with bronze, silver, gold and platinum tiers: sales, net worth, businesses, battles won, territories taken, technologies, alliances, peace treaties, domination and more. They pay XP, plus a crate at gold and platinum. |
| Season | A free 40-tier track each month. All XP counts and each tier needs 400 XP. Every tier has a reward: crates, cash and a season title at tiers 20 and 40. |

## Nations

**The world.** There are 175 countries from Natural Earth (public domain), with their real population and GDP. Countries that share a land border are linked by land. Coasts within 450 km are linked by sea. The links are checked so the whole world is connected.

**Country selection.** After creating a profile, a player picks a country on a world map. It works first come, first served:

- Each country has at most one human leader. A database row lock and a unique index make two simultaneous claims impossible.
- A country can be claimed while an AI leads it, even if an AI nation has conquered it.
- A country cannot be claimed while another human holds its homeland. It shows as "Conquered by …".
- Claiming resets the country to a fresh start: homeland only, a starting treasury, garrison and barracks, no wars, no alliances and no research. Anything else it held goes back to those countries' own (AI) governments.
- A new leader gets 24 hours of protection from attack.
- A leader inactive for 14 days hands the country back to the AI.
- When every country is taken, a player can still play the business game and is offered a country as soon as one frees up.

**Economy.** Each country has:

- A treasury, with income from its territories that scales with the square root of GDP. This keeps small countries viable.
- A tax rate (low, normal or high). Higher tax means more income and less stability.
- Research and infrastructure budget shares. Infrastructure raises development, which raises income.
- Manpower, which regenerates with population.
- Stability (0–100). Stability drops with high tax, wars and war exhaustion, and rises with peace and alliances. Low stability cuts income and makes occupied land revolt.
- Upkeep for units and buildings. If the treasury runs dry, units desert.

The leader can invest personal cash into the treasury. The nation pays its human leader a stipend of 3% of income as personal cash.

**Military.**

| Unit | Attack | Defence | Cost | Notes |
| --- | --- | --- | --- | --- |
| Infantry | 1 | 2 | $300 + 100 manpower | Barracks |
| Artillery | 3 | 1.5 | $1,200 | Factory + Field Artillery |
| Armour | 4 | 3 | $1,800 | Factory + Mechanized Warfare |
| Air wing | 5 | 2.5 | $4,000 | Airbase + Aviation; can strike 2,500 km away |
| Fleet | 3 | 5 | $5,000 | Naval base (coast) + Blue-Water Navy; removes the sea-crossing penalty |
| Missile | — | — | $8,000 | Silo + Ballistic Missiles; strikes 3,000 km away, hurts garrisons and buildings |

Buildings go in each territory you own and have levels:

- Barracks, factory, airbase and naval base unlock units and speed up training.
- Forts add +15% defence per level.
- Air defence weakens air attacks and intercepts missiles.
- A research lab adds research.
- A missile silo enables missiles.

The research tree has 21 technologies across land, air, sea, defence, strategy and economy. Training, construction and research all take real time.

**War.**

- **Declaring war.** Needs level 5, no truce or non-aggression pact, and a target that is not protected. The declarer loses stability and relations, and everyone sees it in the world news.
- **Allies.** Allies of the defender join automatically.
- **Movement.** Armies move along land and sea links. Air and missile strikes reach further.
- **Battles.** These are resolved when an army arrives:
  - Strength is units × attack (or defence) × technology × perks × forts.
  - The defender adds a local militia.
  - The attacker's strength varies by ±10%.
  - Crossing the sea without a fleet costs 40% of attack strength.
  - Each air-defence level removes 20% of air attack.
  - The winner's losses follow the square law: `1 − √(1 − r²)`.
  - A ground victory occupies the territory.
- **War score.** Score comes from occupied land (weighted by value) and battles won.
- **War exhaustion.** Exhaustion grows with time and losses and lowers stability.
- **Peace terms.** Peace is white peace, annexing occupied land, or reparations. Unconditional surrender hands over everything occupied plus 25% of the treasury. A country that loses all its land capitulates. Peace starts a 24-hour truce.
- **Diplomacy.** Players can improve relations by sending an envoy, denounce a nation (which marks it as a rival), sign non-aggression pacts, and form alliances of up to 6 nations that defend each other.

**AI nations.**

- **Skill.** Every AI country has a skill from 1 to 5, given mostly by economic weight with some variation. Skill changes how well it judges:
  - Low-skill AI misjudges strength by up to ±40%, keeps its army in the capital, recruits mostly infantry, and forgets that its target's allies will join.
  - High-skill AI estimates strength accurately, moves troops to threatened borders, builds forts where it is threatened, mixes unit types, researches what the situation needs, and counts allies before declaring war.
- **Personality.** Each AI also has a personality: aggressive, expansionist, defensive, diplomatic, balanced or mercantile.
- **How it decides.** Every few minutes each AI scores its options and takes the best: taxes, budget, research, recruiting, building, moving troops, attacking, peace, alliances and relations.
- **Wars are never sudden.** An AI first denounces its target, which the target is told about. It declares war only after an hour of tension, when it expects to win by a margin set by its caution. It makes peace when exhaustion or the war score says so.
- **No cheating, no randomness.** AI uses the same rules and costs as players. Its misjudgments come from a stable per-pair estimate, not random flips.

**World domination.**

- **Domination share.** Each territory's value is 50% GDP share, 30% population share and 20% count share. A nation's domination share is the value of what it owns.
- **Power index.** It combines income, military strength, technology, territory and alliances.
- **Milestones.** Achievements mark the milestones: regional power, continental hegemon, superpower and world hegemon.
- **Winning an era.** A nation that holds 50% of world value wins the era. Otherwise, after 90 days, the top power wins. The winner enters the Hall of Fame, and a new era resets the map while every leader keeps their country.

## Sources

- [Progression curves in game design](https://dev.to/sam_novak_574b07811e18495/progression-curves-in-game-design-why-good-systems-feel-invisible-and-bad-ones-feel-like-grind-26bo)
- [Power progression in games](https://gamedeveloper.com/design/power-progression-in-games-crafting-rewarding-player-experiences)
- [Power progression (How to make an RPG)](https://howtomakeanrpg.com/r/a/power-progression.html)
- [Designing progression that feels like play, not grind](https://sia.hackernoon.com/designing-progression-that-feels-like-play-not-grind)
- [Warframe reward loops](https://saschb2b.github.io/game-mechanics/games/warframe/reward-loops)
- [From high-score tables to battle passes](https://allcorrectgames.com/insights/from-high-score-tables-to-battle-passes-the-evolution-of-player-retention/)
- [The business of player retention](https://cogconnected.com/2025/05/the-business-of-player-retention-in-2025/)
- [Goal pursuit (goal-gradient and endowed-progress effects)](https://en.wikipedia.org/wiki/Goal_pursuit)
- [Goal-gradient effect (Laws of UX)](https://lawsofux.com/goal-gradient-effect/index.md)
- [Victoria 3 dev diary: diplomatic improvements](https://paradoxinteractive.com/games/victoria-3/news/dev-diary-75-diplomatic-improvements-in-1-2)
- [Teaching Paradox: the ruin of war (ACOUP)](https://acoup.blog/2021/08/20/collections-teaching-paradox-victoria-ii-part-ii-the-ruin-of-war/)
- [War weariness in Civilization VI](https://civilization.fandom.com/wiki/War_weariness_(Civ6))
- [Simulating the cost of war (EU4)](https://gameinformer.com/games/europa_universalis_iv/b/linux/archive/2013/07/26/simulating-the-cost-of-war.aspx)
- [Supremacy 1914 on Steam](https://store.steampowered.com/app/979920/Supremacy%201914)
- [Supremacy 1914 overview](https://gamepressure.com/games/supremacy-1914/z42f57)
- [Age of Wonders: Planetfall AI personalities](https://forum.paradoxplaza.com/forum/threads/age-of-wonders-planetfall-dev-diary-62-ai-personalities-diplomacy-improvements.1392190/)
- [Galactic Civilizations III personalities](https://galciv3.fandom.com/wiki/Personality)
- [Game AI and our cheatin' hearts](https://www.gamedeveloper.com/game-platforms/analysis-game-ai-our-cheatin-hearts)
- [Civilization VI difficulty and AI bonuses](https://www.pcgamesn.com/civilization-vi/civ-6-difficulty-ai-bonus)
- [Lanchester models (FSU lecture notes)](https://www.math.fsu.edu/~mesterto/NewCourses/MAP5932/2016/Notes/lecture02.pdf)
- [Lanchester square law and fighting strength (Atkinson, Kress, MacKay)](https://eprints.whiterose.ac.uk/162499/1/Atkinson_Kress_MacKay.pdf)
