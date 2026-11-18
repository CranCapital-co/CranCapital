# Sounds

Every sound in the game is made in code today (`client/src/audio/sound.ts`),
so nothing needs downloading. To use real recordings instead, put short MP3
files in `client/public/sounds/` and list them in
`client/public/sounds/manifest.json` as `"name": "file.mp3"`. A listed file
replaces the made-in-code version of that sound.

Keep them CC0 (for example Kenney's audio packs, or Freesound filtered to
CC0) or record your own, and add the source to the Credits page. Keep the
whole set under 1.5 MB.

| Name | When it plays | Feel |
| --- | --- | --- |
| `tap` | Any button | A soft wooden click |
| `open`, `close` | A window slides in or out | A short whoosh |
| `sale` | A sale at a business you can see (pitch rises with the amount) | A warm bell ding |
| `chaching` | Three or more sales in quick succession | Cash-register drawer and bells |
| `coin`, `coins` | Coins landing in the cash counter | Small bright clinks |
| `hammer` | Building something | Three hammer knocks |
| `levelup` | A business levels up | A rising four-note chime |
| `tierup` | You reach a new tier | A short brass fanfare |
| `badge` | A badge is earned | Two bells |
| `success` | An action worked | Two rising notes |
| `notify` | A notification arrives | A two-tone chime |
| `chat` | A chat message or DM | A soft pop |
| `buy`, `sell` | Market orders | A click and a rising or falling blip |
| `error` | Something went wrong | A soft low thud |
| `horn` | A ship leaves port | A ship's horn |
| `whoosh`, `pop` | Camera flights, things appearing | Air, a pop |

The city ambience (a low hum, passing cars, birds by day, rain when it's
raining) is also made in code; it fades as you zoom out.
