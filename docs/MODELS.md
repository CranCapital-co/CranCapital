# Models

Every 3D model in CranCapital is built in code from simple parts, so the
game needs no model downloads and every model shares one material (one
colour per vertex), which keeps iPad draw calls low:

- `client/src/world3d/people.ts`: the player character, the 14 outfits,
  crowd walkers, things people carry, the net-worth ring.
- `client/src/world3d/models.ts`: one model for every business type, levels
  1 to 5, plus closed, abandoned and depleted looks; props (lamps, coins,
  scaffolding, the build crane) and vehicles.
- `client/src/world3d/kit.ts`: the parts (rounded boxes, cylinders, gables,
  striped awnings) they're made from.

## Replacing a model with one made in Blender

1. Model it low-poly, facing +Z (toward the street), 1 unit = 1 metre, with
   the origin on the ground at the centre (for shopfronts: at the middle of
   the shop's front wall, with the shop extending toward +Z).
2. Colour it from the shared palette texture (UV each face onto a colour
   swatch) or with plain material colours. Textures other than the palette
   are ignored.
3. Export glTF binary (`.glb`), then compress it:
   `npx @gltf-transform/cli meshopt in.glb out.glb`
4. Put it in `client/public/models/` and add it to
   `client/public/models/manifest.json`, keyed by business type (all
   levels) or `type:level` (one level), for example
   `{ "cart:1": "cart_l1.glb", "bank": "bank.glb" }`.

A hand-made model replaces the built-in one but loses its moving parts
(turning wheels, nodding pumps); those are listed below so they can be
rebuilt as separate objects later.

## Wanted models

Sizes are the footprint the game expects (metres), triangle budgets per
model, and the moving parts the built-in model has.

| Model | Footprint × height | Triangles | Pivot | Moving parts / animations |
| --- | --- | --- | --- | --- |
| Player character | 2 × 6.5 (≈3.5× real) | 800 | between the feet | Rig with one shared skeleton: idle, walk, run, wave, cheer, sit, phone. Outfits as swappable parts (hats, vest, tie) |
| Crowd walker (3 body shapes) | 1.4 × 5 | 150 each | between the feet | Walk bob, leg swing |
| Food cart L1–L2 | 4.6 × 2.8 × 4.8 | 600 | centre, on the ground | Steam; vendor waves |
| Food truck (L3+) | 8 × 3.4 × 5 | 900 | centre | Steam |
| Café / restaurant / grocery dressing | 8–10 wide × 6.5 | 800 | middle of the front wall | Steam from cups; string lights at night |
| Furniture / electronics store dressing | 8–10 wide × 6.5 | 700 | middle of the front wall | Screens flicker |
| Bank front | 10–14 wide × 10 | 900 | middle of the front wall | Flags (L3+) |
| Farm | 22 × 22 × 9 | 1,500 | plot centre | Crop rows grow; tractor drives the rows (L4+) |
| Tree farm | 22 × 22 × 5 | 1,500 | plot centre | Trees grow, get cut, regrow |
| Storage yard | 22 × 22 × up to 13 | 1,200 | plot centre | Containers stack with storage fill; forklift |
| Apartment block | 13 × 11 × (3 + 2 per level floors) | 2,000 | plot centre | Windows light up at night |
| Coal / iron / copper mine | 20 × 20 × 18 | 1,500 | plot centre | Headframe wheel turns |
| Limestone quarry, sand pit | 20 × 20 × 6 | 1,000 | plot centre | Digger arm |
| Oil well | 20 × 20 × 7 | 1,000 | plot centre | Pumpjacks nod |
| Flour mill | 20 × 20 × 20 | 1,000 | plot centre | Sails turn |
| The other nine factories | 22 × 22 × 14–18 | 1,500 | plot centre | Smoke while running; furnace glow |
| Port quay | 26–28 long × 9 × 16 | 2,000 | quay centre | Crane boom swings; ship sails |
| Car, taxi, van, bus, ship | real size × 1.6 | 300 (ship 800) | centre | Wheels |
