// CranCapital's icon set: one SVG sprite, drawn on a 24-point grid with
// rounded 2-point strokes. Accent shapes (A) are filled with the --accent
// colour (the tier colour where it matters, gold otherwise); it's an inline
// style so the colour reaches through <use> into each copy.
// Goods have small illustrated icons in full colour.

const A = 'style="fill:var(--accent,#e8a93a);stroke:none"';

export const UI_ICONS: Record<string, string> = {
  // Dock and HUD
  build: `<rect ${A} x="4" y="4" width="16" height="16" rx="5" opacity=".25"/><path d="M12 8v8M8 12h8"/>`,
  empire: `<path ${A} d="M4 20V10l4-3 4 3v10z" opacity=".3"/><path d="M4 20V10l4-3 4 3v10M12 20V6l4-3 4 3v14M2 20h20M7 13h2M7 16h2M15 9h2M15 12h2M15 15h2"/>`,
  market: `<path ${A} d="M3 20 9 13l4 3 8-9v13z" opacity=".25"/><path d="M3 17l6-6 4 3 8-8M15 6h6v6"/>`,
  people: `<circle ${A} cx="9" cy="8" r="3.5" opacity=".3"/><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>`,
  more: `<circle ${A} cx="5" cy="12" r="2"/><circle ${A} cx="12" cy="12" r="2"/><circle ${A} cx="19" cy="12" r="2"/>`,
  help: `<circle ${A} cx="12" cy="12" r="9" opacity=".2"/><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>`,
  account: `<circle ${A} cx="12" cy="8" r="4" opacity=".3"/><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  staff: `<path ${A} d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" opacity=".25"/><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6zM9 12l2 2 4-4"/>`,
  bell: `<path ${A} d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" opacity=".25"/><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>`,
  sound: `<path ${A} d="M4 9h4l5-4v14l-5-4H4z" opacity=".3"/><path d="M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>`,
  mute: `<path ${A} d="M4 9h4l5-4v14l-5-4H4z" opacity=".3"/><path d="M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6"/>`,
  view: `<path ${A} d="M12 3 3 8l9 5 9-5z" opacity=".3"/><path d="M12 3 3 8l9 5 9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5"/>`,
  // Map tools
  locate: `<circle ${A} cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`,
  land: `<path ${A} d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" opacity=".2"/><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/>`,
  heat: `<path ${A} d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.3-5.6-3.8-7.4-.3 1.6-1.2 2.6-2.2 3 .3-3.4-1.4-6.5-4-8 .3 3-1.5 5.2-3 7.2C4.7 11.9 5 13.5 5 15.4 5 19.3 8 22 12 22z" opacity=".3"/><path d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.3-5.6-3.8-7.4-.3 1.6-1.2 2.6-2.2 3 .3-3.4-1.4-6.5-4-8 .3 3-1.5 5.2-3 7.2C4.7 11.9 5 13.5 5 15.4 5 19.3 8 22 12 22z"/>`,
  taxi: `<path ${A} d="M4 15h16v3H4z" opacity=".3"/><path d="M5 11l1.8-4.2A2 2 0 0 1 8.6 5.5h6.8a2 2 0 0 1 1.8 1.3L19 11M3 15a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3H3zM10 3h4M7 18v2M17 18v2"/><circle cx="7.5" cy="15" r=".6"/><circle cx="16.5" cy="15" r=".6"/>`,
  tools: `<path ${A} d="M4 4h7v7H4z" opacity=".3"/><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 16.5h7M16.5 13v7"/>`,
  // Window chrome and actions
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  back: `<path d="M15 5l-7 7 7 7"/>`,
  next: `<path d="M9 5l7 7-7 7"/>`,
  widen: `<path d="M12 5l-7 7 7 7M19 5l-7 7 7 7"/>`,
  narrow: `<path d="M5 5l7 7-7 7M12 5l7 7-7 7"/>`,
  down: `<path d="M5 9l7 7 7-7"/>`,
  up: `<path d="M5 15l7-7 7 7"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  check: `<path d="M4.5 12.5l5 5 10-11"/>`,
  warn: `<path ${A} d="M12 3 2 20h20z" opacity=".3"/><path d="M12 3 2 20h20zM12 9v5M12 17h.01"/>`,
  info: `<circle ${A} cx="12" cy="12" r="9" opacity=".2"/><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>`,
  lock: `<rect ${A} x="5" y="10" width="14" height="11" rx="2.5" opacity=".3"/><rect x="5" y="10" width="14" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2.5"/>`,
  edit: `<path ${A} d="M4 20l1-4L16 5l3 3L8 19z" opacity=".3"/><path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"/>`,
  refresh: `<path d="M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>`,
  settings: `<circle ${A} cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/><circle cx="12" cy="12" r="6"/>`,
  sparkle: `<path ${A} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" opacity=".35"/><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>`,
  camera: `<path ${A} d="M3 8h4l2-3h6l2 3h4v12H3z" opacity=".25"/><path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13.5" r="3.5"/>`,
  eye: `<path ${A} d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" opacity=".2"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  pin: `<path ${A} d="M12 22s7-6.5 7-12.5a7 7 0 0 0-14 0C5 15.5 12 22 12 22z" opacity=".3"/><path d="M12 22s7-6.5 7-12.5a7 7 0 0 0-14 0C5 15.5 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/>`,
  // Money and progress
  coin: `<circle ${A} cx="12" cy="12" r="9" opacity=".35"/><circle cx="12" cy="12" r="9"/><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.6-1.2-1.6 0-2.7.8-2.7 2 0 2.8 5.6 1.4 5.6 4.1 0 1.2-1.2 2-2.9 2-1.2 0-2.2-.5-2.8-1.3M12 6.5V8M12 16v1.5"/>`,
  cash: `<rect ${A} x="2" y="6" width="20" height="12" rx="2.5" opacity=".25"/><rect x="2" y="6" width="20" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v.01M18 14.5v.01"/>`,
  trendUp: `<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>`,
  trendDown: `<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>`,
  chart: `<path ${A} d="M7 14v6M12 10v10M17 6v14" opacity=".4"/><path d="M3 20h18M7 14v6M12 10v10M17 6v14"/>`,
  trophy: `<path ${A} d="M7 4h10v5a5 5 0 0 1-10 0z" opacity=".35"/><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v4M8 20h8M9.5 18h5"/>`,
  medal: `<circle ${A} cx="12" cy="15" r="5" opacity=".35"/><circle cx="12" cy="15" r="5"/><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8"/>`,
  star: `<path ${A} d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" opacity=".35"/><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>`,
  gift: `<rect ${A} x="4" y="10" width="16" height="10" rx="1.5" opacity=".3"/><path d="M3 7h18v3H3zM4 10v10h16V10M12 7v13M12 7c-1.5-3.5-5-3.5-5-1.5S10 7 12 7zM12 7c1.5-3.5 5-3.5 5-1.5S14 7 12 7z"/>`,
  flag: `<path ${A} d="M5 4h12l-2 4 2 4H5z" opacity=".35"/><path d="M5 21V4h12l-2 4 2 4H5"/>`,
  tag: `<path ${A} d="M3 12V4h8l10 10-8 8z" opacity=".25"/><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>`,
  // Places and things
  storage: `<path ${A} d="M3 8l9-5 9 5v12H3z" opacity=".2"/><path d="M3 8l9-5 9 5v12H3zM7 20v-8h10v8M7 15h10"/>`,
  box: `<path ${A} d="M3 7l9-4 9 4v10l-9 4-9-4z" opacity=".25"/><path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>`,
  bank: `<path ${A} d="M3 9l9-5 9 5z" opacity=".35"/><path d="M3 9l9-5 9 5zM5 9v8M9.5 9v8M14.5 9v8M19 9v8M3 20h18M4 17h16"/>`,
  chat: `<path ${A} d="M4 5h16v11H9l-5 4z" opacity=".25"/><path d="M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5"/>`,
  friends: `<path d="M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a6.5 6.5 0 0 1 13 0"/><path ${A} d="M17 12.5l-3.5-3.4a2 2 0 0 1 2.9-2.8l.6.6.6-.6a2 2 0 0 1 2.9 2.8z"/>`,
  handshake: `<path ${A} d="M8 12l3 3c.8.8 2 .8 2.8 0l3.7-3.7" opacity=".4"/><path d="M2 12l4-5 4 2 3-1 4 1 5 3M2 12l3 3M22 12l-3 3M8 12l3 3c.8.8 2 .8 2.8 0l3.7-3.7M10.5 14.5 8.5 16.5M12.5 16.5l-1.5 1.5"/>`,
  minefield: `<path ${A} d="M3 19h18v2H3z" opacity=".35"/><path d="M3 20h18"/><circle cx="7" cy="16" r="2.5"/><circle cx="16" cy="15" r="3"/><path d="M7 13.5V12M16 12v-1.5M13.5 13l-1-1M18.5 13l1-1M5 14.5l-1-1"/>`,
  swords: `<path ${A} d="M14.5 17.5 20 12V4h-8L6.5 9.5" opacity=".25"/><path d="M14.5 17.5 20 4l-13.5 5.5M13 19l6 6M19 13l-6 6M4 4l8 8M5 14l5 5M3 21l4-4M17 17l4 4"/>`,
  shield: `<path ${A} d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" opacity=".3"/><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/>`,
  tank: `<rect ${A} x="3" y="13" width="18" height="6" rx="3" opacity=".3"/><path d="M6 13V10h9l2 3M10 10V8h8M3 16a3 3 0 0 1 3-3h12a3 3 0 0 1 0 6H6a3 3 0 0 1-3-3z"/><circle cx="7" cy="16" r="1"/><circle cx="12" cy="16" r="1"/><circle cx="17" cy="16" r="1"/>`,
  target: `<circle ${A} cx="12" cy="12" r="4" opacity=".35"/><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  flask: `<path ${A} d="M6.5 16h11l2 4H4.5z" opacity=".35"/><path d="M9 3h6M10 3v6L4 20h16L14 9V3M7.5 14h9"/>`,
  radar: `<path ${A} d="M12 12 19 5a10 10 0 0 1 2 7z" opacity=".35"/><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l7-7"/>`,
  rocket: `<path ${A} d="M12 2c3 2.5 4.5 6 4.5 10l-2 3h-5l-2-3c0-4 1.5-7.5 4.5-10z" opacity=".3"/><path d="M12 2c3 2.5 4.5 6 4.5 10l-2 3h-5l-2-3c0-4 1.5-7.5 4.5-10zM7.5 12 5 15v3l4-2M16.5 12 19 15v3l-4-2M10 19l2 3 2-3"/><circle cx="12" cy="9" r="1.5"/>`,
  dove: `<path ${A} d="M3 13c3 0 6-1 8-3l2 2c-2 4-6 6-10 6z" opacity=".3"/><path d="M3 13c3 0 6-1 8-3 1-3 3-5 6-5l2 2-2 1c0 6-4 10-11 10H3l3-3M13 12l3 7M17 5h.01"/>`,
  fire: `<path ${A} d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.3-5.6-3.8-7.4-.3 1.6-1.2 2.6-2.2 3 .3-3.4-1.4-6.5-4-8 .3 3-1.5 5.2-3 7.2C4.7 11.9 5 13.5 5 15.4 5 19.3 8 22 12 22z" opacity=".35"/><path d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.3-5.6-3.8-7.4-.3 1.6-1.2 2.6-2.2 3 .3-3.4-1.4-6.5-4-8 .3 3-1.5 5.2-3 7.2C4.7 11.9 5 13.5 5 15.4 5 19.3 8 22 12 22z"/>`,
  truck: `<path ${A} d="M3 6h11v10H3z" opacity=".3"/><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7M3 16h18"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>`,
  crown: `<path ${A} d="M4 8l4 4 4-6 4 6 4-4-2 10H6z" opacity=".35"/><path d="M4 8l4 4 4-6 4 6 4-4-2 10H6zM6 21h12"/>`,
  bolt: `<path ${A} d="M13 2 4 14h7l-1 8 9-12h-7z" opacity=".4"/><path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`,
  crate: `<path ${A} d="M3 8h18v12H3z" opacity=".3"/><path d="M3 8h18v12H3zM2 4h20v4H2zM10 12h4"/>`,
  dice: `<rect ${A} x="4" y="4" width="16" height="16" rx="4" opacity=".25"/><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>`,
  globe: `<circle ${A} cx="12" cy="12" r="9" opacity=".2"/><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>`,
  plane: `<path ${A} d="M10.5 13 3 11.5l1.5-2L11 10l4.5-5.5c.8-1 2.4-1.2 3.3-.3s.7 2.5-.3 3.3L13 12l.5 6.5-2 1.5z" opacity=".3"/><path d="M10.5 13 3 11.5l1.5-2L11 10l4.5-5.5c.8-1 2.4-1.2 3.3-.3s.7 2.5-.3 3.3L13 12l.5 6.5-2 1.5zM5 18l3-3"/>`,
  ship: `<path ${A} d="M3 15h18l-2.5 4.5h-13z" opacity=".35"/><path d="M3 15h18l-2.5 4.5h-13zM6 15V9h12v6M9 9V5h4v4M2 22c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1"/>`,
  island: `<path ${A} d="M3 18c3-2 6-3 9-3s6 1 9 3z" opacity=".35"/><path d="M3 18c3-2 6-3 9-3s6 1 9 3M12 15V8M12 8c-2-3-6-3-7-1M12 8c2-3 6-3 7-1M12 8c-1-2-3-4-5-4M12 8c1-2 3-4 5-4M2 21h20"/>`,
  clock: `<circle ${A} cx="12" cy="12" r="9" opacity=".2"/><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  calendar: `<rect ${A} x="3" y="5" width="18" height="5" opacity=".3"/><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
  mail: `<rect ${A} x="3" y="5" width="18" height="14" rx="2.5" opacity=".2"/><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5 12 13l8.5-6.5"/>`,
  bug: `<rect ${A} x="7" y="8" width="10" height="12" rx="5" opacity=".3"/><rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 8a3 3 0 0 1 6 0M3 13h4M17 13h4M4 8l3 2M20 8l-3 2M4 19l3-2M20 19l-3-2M12 11v9"/>`,
  idea: `<path ${A} d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.7-1.5 1.6-1.5 2.5h-4c0-.9-.7-1.8-1.5-2.5z" opacity=".3"/><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.7-1.5 1.6-1.5 2.5h-4c0-.9-.7-1.8-1.5-2.5zM10 20h4"/>`,
  headset: `<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect ${A} x="3" y="14" width="4" height="6" rx="1.5"/><rect ${A} x="17" y="14" width="4" height="6" rx="1.5"/>`,
  book: `<path ${A} d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z" opacity=".25"/><path d="M4 19.5v-15A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5 1.5 1.5 0 0 0 5.5 21H20M8 7h8M8 10.5h5"/>`,
  cleaning: `<path ${A} d="M5 13h14l-1 8H6z" opacity=".3"/><path d="M5 13h14l-1 8H6zM9 13V4h6v9M9 8h6"/>`,
  doc: `<path ${A} d="M6 3h8l4 4v14H6z" opacity=".2"/><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6"/>`,
  bellOff: `<path d="M6 16V11c0-1.2.4-2.4 1-3.4M10 4.3A6 6 0 0 1 18 10v6l2 2H4zM10 21h4M3 3l18 18"/>`,
  // Weather
  sun: `<circle ${A} cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>`,
  moon: `<path ${A} d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" opacity=".35"/><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>`,
  cloud: `<path ${A} d="M7 19a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9.5z" opacity=".25"/><path d="M7 19a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9.5z"/>`,
  partly: `<circle ${A} cx="8" cy="8" r="3.5"/><path d="M8 1.5v1.5M2.5 8H1.5M3.4 3.4l1 1M12.6 3.4l-1 1"/><path d="M9 20a4 4 0 0 1-.5-7.97A5 5 0 0 1 18 11.5a4 4 0 0 1-.5 8.5z"/>`,
  rain: `<path ${A} d="M7 15a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 5.5a4.5 4.5 0 0 1-.5 9.5z" opacity=".25"/><path d="M7 15a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 5.5a4.5 4.5 0 0 1-.5 9.5zM8 18l-1 3M12 18l-1 3M16 18l-1 3"/>`,
  snow: `<path ${A} d="M7 14a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 4.5a4.5 4.5 0 0 1-.5 9.5z" opacity=".25"/><path d="M7 14a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 4.5a4.5 4.5 0 0 1-.5 9.5zM8 18h.01M12 20h.01M16 18h.01M10 22h.01M14 22h.01"/>`,
  fog: `<path d="M3 9h14M6 13h15M3 17h12M8 21h10M7 5h10"/>`,
  storm: `<path ${A} d="M13 13l-3 5h4l-2 4" opacity=".6"/><path d="M7 15a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 5.5a4.5 4.5 0 0 1-.5 9.5M13 13l-3 5h4l-2 4"/>`,
  event: `<path ${A} d="M4 20 9 7l8 8z" opacity=".3"/><path d="M4 20 9 7l8 8zM14 4l1-2M18 8l3-1M17 4l2-2M13 9c1-1.5 2.5-2 4-1.5"/>`,
  // Business kinds (badges until model pictures replace them)
  cart: `<path ${A} d="M4 8h13l-1 7H5z" opacity=".35"/><path d="M2 4h2l2.2 11H17l2-7H5.2M8 20a1.3 1.3 0 1 0 0-2.6A1.3 1.3 0 0 0 8 20zM16 20a1.3 1.3 0 1 0 0-2.6A1.3 1.3 0 0 0 16 20z"/>`,
  cafe: `<path ${A} d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" opacity=".35"/><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M12 3v3M3 21h14"/>`,
  restaurant: `<path ${A} d="M16 3c-2 1.5-3 4-3 7h3v11" opacity=".3"/><path d="M5 3v6a3 3 0 0 0 6 0V3M8 3v18M16 3c-2 1.5-3 4-3 7h3v11"/>`,
  grocery: `<path ${A} d="M4 9h16l-2 11H6z" opacity=".3"/><path d="M4 9h16l-2 11H6zM8 9l3-6M16 9l-3-6M9 13v3M15 13v3M12 13v3"/>`,
  sofa: `<path ${A} d="M5 13h14v4H5z" opacity=".35"/><path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M3 12a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v5H3zM5 17v2M19 17v2"/>`,
  screen: `<rect ${A} x="3" y="4" width="18" height="12" rx="2" opacity=".3"/><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>`,
  farm: `<path ${A} d="M4 10l6-5 6 5v10H4z" opacity=".3"/><path d="M4 10l6-5 6 5v10H4zM8 20v-5h4v5M16 20h5V9a2.5 2.5 0 0 0-5 0"/>`,
  tree: `<path ${A} d="M12 3 6 11h3l-4 6h14l-4-6h3z" opacity=".35"/><path d="M12 3 6 11h3l-4 6h14l-4-6h3zM12 17v4"/>`,
  container: `<rect ${A} x="3" y="11" width="18" height="8" opacity=".3"/><rect x="3" y="11" width="18" height="8" rx="1"/><rect x="6" y="5" width="12" height="6" rx="1"/><path d="M7 13v4M11 13v4M15 13v4"/>`,
  apartments: `<rect ${A} x="5" y="3" width="14" height="18" rx="1.5" opacity=".2"/><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M11 21v-3h2v3"/>`,
  mine: `<path ${A} d="M3 21h18l-4-6H7z" opacity=".35"/><path d="M3 21h18l-4-6H7zM8 15V5h8v10M8 5l8 6M16 5l-8 6"/><circle cx="12" cy="4" r="2"/>`,
  quarry: `<path ${A} d="M2 20l4-6h12l4 6z" opacity=".3"/><path d="M2 20l4-6h12l4 6zM6 14l2-4h8l2 4M8 10l2-3h4l2 3"/>`,
  oil: `<path ${A} d="M4 20h16" opacity=".5"/><path d="M4 20h16M7 20l3-9 3 9M3 8l14-3M17 5l3 1.5-1 3-3-1M10 11l-3-4.5"/>`,
  factory: `<path ${A} d="M3 20V10l5 3V10l5 3V10l5 3V4h3v16z" opacity=".25"/><path d="M3 20V10l5 3V10l5 3V10l5 3V4h3v16zM7 17h2M12 17h2"/>`,
  mill: `<path ${A} d="M9 21l1-10h4l1 10z" opacity=".35"/><path d="M9 21l1-10h4l1 10M12 8 6 3M12 8l6-5M12 8l-6 5M12 8l6 5"/>`,
  port: `<path ${A} d="M3 17h10v4H3z" opacity=".35"/><path d="M15 21V5h2v16M15 5H6l9 4M17 5h4v3M10 5v6M8 11h4v3H8zM3 17h10v4H3z"/>`,
  shop: `<path ${A} d="M3 9h18v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" opacity=".35"/><path d="M4 5h16l1 4v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9zM5 13v8h14v-8M10 21v-5h4v5"/>`,
  skyline: `<path ${A} d="M3 21V9h5v12M16 21V6h5v15" opacity=".25"/><path d="M3 21V9h5v12M8 21V4h8v17M16 21V6h5v15M2 21h20M11 8h2M11 12h2M11 16h2"/>`,
  // Fit-out pieces
  counter: `<path ${A} d="M3 10h18v3H3z" opacity=".35"/><path d="M3 10h18v3H3zM5 13v7h14v-7M9 13v7M15 13v7M7 10V7h4v3"/>`,
  table: `<ellipse ${A} cx="12" cy="9" rx="8" ry="3" opacity=".35"/><ellipse cx="12" cy="9" rx="8" ry="3"/><path d="M12 12v8M8 20h8"/>`,
  booth: `<path ${A} d="M4 12h16v3H4z" opacity=".35"/><path d="M4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14M4 12h16v3H4zM7 15v5M17 15v5"/>`,
  stove: `<rect ${A} x="4" y="9" width="16" height="12" rx="1.5" opacity=".25"/><rect x="4" y="9" width="16" height="12" rx="1.5"/><path d="M4 13h16M8 3v3M12 2v4M16 3v3"/><circle cx="8.5" cy="17" r="1.5"/><circle cx="15.5" cy="17" r="1.5"/>`,
  espresso: `<rect ${A} x="5" y="3" width="14" height="6" rx="1.5" opacity=".35"/><path d="M5 3h14v6H5zM7 9v11h10V9M10 13h4v3a2 2 0 0 1-4 0zM5 20h14"/>`,
  shelf: `<path ${A} d="M4 9h16M4 15h16" opacity=".5"/><path d="M4 3v18M20 3v18M4 9h16M4 15h16M7 6h3M13 6h4M7 12h5M15 12h2M7 18h3M13 18h4"/>`,
  fridge: `<rect ${A} x="6" y="2" width="12" height="20" rx="2" opacity=".2"/><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M6 9h12M9 5v2M9 12v4"/>`,
  display: `<path ${A} d="M3 10h18v6H3z" opacity=".3"/><path d="M3 10l2-6h14l2 6M3 10h18v6H3zM5 16v5M19 16v5M8 13h2M14 13h2"/>`,
  plant: `<path ${A} d="M12 13C9 13 6 10 6 6c3 0 6 3 6 7zM12 11c0-3 2-6 6-6 0 3-3 6-6 6z" opacity=".4"/><path d="M12 13C9 13 6 10 6 6c3 0 6 3 6 7zM12 11c0-3 2-6 6-6 0 3-3 6-6 6zM12 9v6M8 15h8l-1 6H9z"/>`,
  art: `<rect ${A} x="6" y="7" width="12" height="9" opacity=".3"/><rect x="3" y="4" width="18" height="15" rx="1.5"/><path d="M6 16l4-4 3 3 2-2 3 3M15 9.5h.01"/>`,
  lamp: `<path ${A} d="M7 10l2-6h6l2 6z" opacity=".35"/><path d="M7 10l2-6h6l2 6zM12 10v9M8 21h8M10 13l-1 2M14 13l1 2"/>`,
  safe: `<rect ${A} x="3" y="4" width="18" height="16" rx="2" opacity=".25"/><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5v1M15.5 12h-1M6 20v1.5M18 20v1.5"/>`,
  eraser: `<path ${A} d="M8 20l-4-4L14 6l6 6-8 8z" opacity=".3"/><path d="M8 20l-4-4L14 6l6 6-8 8zM10 10l6 6M8 20h12"/>`,
  palm: `<path ${A} d="M12 11c-3-3-7-2-8 0 3-.5 5 0 8 0z" opacity=".35"/><path d="M12 22c0-4 .5-8 0-11M12 11c-3-3-7-2-8 0 3-.5 5 0 8 0zM12 11c3-3 7-2 8 0-3-.5-5 0-8 0zM12 11c-1-3-4-6-7-5 2 1 4 2 7 5zM12 11c1-3 4-6 7-5-2 1-4 2-7 5zM7 22h10"/>`,
};

// Small full-colour illustrations for goods (24 grid). Kept simple: two or
// three flat shapes and a soft dark outline.
const O = 'stroke="#2b2b2b" stroke-width="1.2" stroke-linejoin="round"';
export const GOOD_ICONS: Record<string, string> = {
  lettuce: `<path ${O} fill="#7cc35a" d="M12 20c-5 0-8-3-8-7 0-2 1-3 2-4 0-3 3-5 6-5s6 2 6 5c1 1 2 2 2 4 0 4-3 7-8 7z"/><path fill="none" stroke="#3f7f2c" stroke-width="1.2" d="M12 20V10M12 14l-3-3M12 16l3-3"/>`,
  tomato: `<circle ${O} fill="#e5533d" cx="12" cy="13.5" r="7.5"/><path fill="#4a9a3a" d="M12 6.5l-3-2 1.5 3-3 .5 3 1.2L12 8l1.5 1.2 3-1.2-3-.5 1.5-3z"/>`,
  banana: `<path ${O} fill="#f4cf3f" d="M5 6c-1 7 4 13 13 12 1 0 1-1.5 0-1.8C12 15 8 12 7.3 6.3 7.1 5 5.2 4.9 5 6z"/><path fill="#6b4a1f" d="M5.2 4.5h2l-.3 2h-1.6z"/>`,
  pumpkin: `<ellipse ${O} fill="#f08a2e" cx="12" cy="14" rx="8" ry="6.5"/><path fill="none" stroke="#b55a14" stroke-width="1.2" d="M12 8c-2 2-2 10 0 12M12 8c2 2 2 10 0 12"/><path fill="#4a9a3a" d="M11.2 4h1.6l.4 4h-2.4z"/>`,
  wasabi: `<path ${O} fill="#9ccf6a" d="M9 21c-1-4-1-9 1-12h4c2 3 2 8 1 12z"/><path fill="#4a9a3a" d="M10 9C8 6 6 5 5 5c1 2 3 3 5 4zM14 9c2-3 4-4 5-4-1 2-3 3-5 4zM12 9V3"/><path stroke="#4a9a3a" stroke-width="1.4" d="M12 9V3"/>`,
  wheat: `<path fill="none" stroke="#a87b28" stroke-width="1.4" d="M12 21V6"/><g fill="#e8c05a" ${O}><ellipse cx="9.5" cy="8" rx="1.6" ry="2.6" transform="rotate(-25 9.5 8)"/><ellipse cx="14.5" cy="8" rx="1.6" ry="2.6" transform="rotate(25 14.5 8)"/><ellipse cx="9.5" cy="12" rx="1.6" ry="2.6" transform="rotate(-25 9.5 12)"/><ellipse cx="14.5" cy="12" rx="1.6" ry="2.6" transform="rotate(25 14.5 12)"/><ellipse cx="12" cy="4.5" rx="1.5" ry="2.4"/></g>`,
  potato: `<path ${O} fill="#c9985a" d="M5 13c0-4 3-7 7-7 5 0 8 2.5 8 6.5S17 19 12 19c-4 0-7-2-7-6z"/><g fill="#8c6534"><circle cx="9" cy="11" r=".8"/><circle cx="14" cy="10" r=".8"/><circle cx="15.5" cy="14.5" r=".8"/><circle cx="10.5" cy="15.5" r=".8"/></g>`,
  rice: `<path ${O} fill="#e8dfc8" d="M5 9h14l-1.5 9a2 2 0 0 1-2 1.7h-7a2 2 0 0 1-2-1.7z"/><path ${O} fill="#ffffff" d="M5 9c1-3 4-4.5 7-4.5S18 6 19 9z"/>`,
  coffee: `<ellipse ${O} fill="#7a4a26" cx="9" cy="12" rx="4" ry="5.5" transform="rotate(-20 9 12)"/><ellipse ${O} fill="#8c5a30" cx="15.5" cy="12" rx="4" ry="5.5" transform="rotate(20 15.5 12)"/><path fill="none" stroke="#3d2412" stroke-width="1.2" d="M10.5 7c-2 3-1 7-3 10M14 7c2 3 1 7 3 10"/>`,
  coal: `<path ${O} fill="#3a3a3f" d="M4 16l3-7 5-2 6 3 2 6-5 3H8z"/><path fill="#6a6a72" d="M8 10l3-1-2 4z"/>`,
  iron_ore: `<path ${O} fill="#8a6f63" d="M4 16l3-7 5-2 6 3 2 6-5 3H8z"/><g fill="#c45b3a"><circle cx="9" cy="12" r="1.3"/><circle cx="14" cy="11" r="1"/><circle cx="13" cy="15.5" r="1.2"/></g>`,
  crude_oil: `<path ${O} fill="#2d2a33" d="M12 3c3 4.5 6 8 6 11.5a6 6 0 0 1-12 0C6 11 9 7.5 12 3z"/><path fill="#57526a" d="M9 14c0 2 1 3 2.5 3.5-2.5.2-4-1.5-2.5-3.5z"/>`,
  limestone: `<path ${O} fill="#e8e2cf" d="M3 17l3-8 6-3 6 3 3 8-4 3H7z"/><path fill="none" stroke="#bdb59c" stroke-width="1" d="M6 13h12M8 9.5h8"/>`,
  sand: `<path ${O} fill="#e8c88a" d="M2 19c3-6 6-9 10-9s7 3 10 9z"/><g fill="#c8a058"><circle cx="9" cy="16" r=".7"/><circle cx="13" cy="14" r=".7"/><circle cx="15" cy="17" r=".7"/></g>`,
  copper_ore: `<path ${O} fill="#7f7a70" d="M4 16l3-7 5-2 6 3 2 6-5 3H8z"/><g fill="#d9853b"><circle cx="9" cy="12" r="1.3"/><circle cx="14.5" cy="11" r="1.1"/></g><g fill="#3fae8f"><circle cx="12.5" cy="15.5" r="1.1"/></g>`,
  timber: `<g ${O}><rect fill="#b07a42" x="3" y="12" width="18" height="5" rx="2.5"/><rect fill="#c48a4c" x="5" y="7" width="15" height="5" rx="2.5"/></g><circle fill="#e8c79a" stroke="#8c5a2c" stroke-width="1" cx="5.5" cy="14.5" r="2"/><circle fill="#e8c79a" stroke="#8c5a2c" stroke-width="1" cx="7.5" cy="9.5" r="2"/>`,
  flour: `<path ${O} fill="#f3eee2" d="M7 5h10l1 3-1 13H7L6 8z"/><path fill="none" stroke="#2b2b2b" stroke-width="1.2" d="M6.5 8h11"/><path fill="#e8c05a" d="M10 12h4v5h-4z"/>`,
  concrete: `<path ${O} fill="#a9aaa6" d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path fill="none" stroke="#2b2b2b" stroke-width="1.2" d="M4 9l8 4 8-4M12 13v8"/>`,
  steel: `<path ${O} fill="#9aa8b8" d="M3 15l4-6h14l-4 6z"/><path ${O} fill="#7a889a" d="M3 15h14v4H3zM17 15l4-6v4l-4 6z"/>`,
  glass: `<path ${O} fill="#bfe6f0" fill-opacity=".9" d="M5 4h14v16H5z"/><path fill="none" stroke="#ffffff" stroke-width="1.6" d="M8 15l6-8M11 17l5-6.5"/>`,
  copper: `<path ${O} fill="#d9853b" d="M3 15l4-6h14l-4 6z"/><path ${O} fill="#b86a28" d="M3 15h14v4H3zM17 15l4-6v4l-4 6z"/>`,
  plastic: `<g ${O}><circle fill="#4fb3e8" cx="8" cy="9" r="3.5"/><circle fill="#f2c14b" cx="16" cy="9" r="3.5"/><circle fill="#e3694d" cx="12" cy="15.5" r="3.5"/></g>`,
  planks: `<g ${O}><rect fill="#d9a66a" x="3" y="6" width="18" height="4" rx="1"/><rect fill="#c8925a" x="3" y="10" width="18" height="4" rx="1"/><rect fill="#d9a66a" x="3" y="14" width="18" height="4" rx="1"/></g>`,
  diesel: `<path ${O} fill="#e8b23a" d="M6 6h9l3 3v11H6z"/><path ${O} fill="#3a3a3f" d="M15 3h3v3h-3z"/><path fill="#2b2b2b" d="M9 12c1.5 2 1.5 4 0 5h3c-1.5-1-1.5-3 0-5z" opacity=".55"/>`,
  ready_meal: `<rect ${O} fill="#f3eee2" x="3" y="7" width="18" height="12" rx="2"/><path fill="#e3694d" d="M5.5 9.5h6v7h-6z"/><path fill="#7cc35a" d="M12.5 9.5h6v3h-6z"/><path fill="#f2c14b" d="M12.5 13.5h6v3h-6z"/>`,
  furniture: `<path ${O} fill="#c8925a" d="M5 12V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4z"/><path ${O} fill="#d9a66a" d="M3 12h18v5H3z"/><path fill="none" stroke="#2b2b2b" stroke-width="1.4" d="M5 17v3M19 17v3"/>`,
  electronics: `<rect ${O} fill="#3a3f4a" x="3" y="4" width="18" height="12" rx="1.5"/><rect fill="#4fb3e8" x="5" y="6" width="14" height="8" rx=".8"/><path fill="none" stroke="#2b2b2b" stroke-width="1.4" d="M9 20h6M12 16v4"/>`,
};

// Interface icon for each business type until its 3D model picture exists.
export const BUSINESS_ICON: Record<string, string> = {
  cart: 'cart', cafe: 'cafe', restaurant: 'restaurant', grocery: 'grocery', furniture_store: 'sofa', electronics_store: 'screen',
  farm: 'farm', tree_farm: 'tree', yard: 'container', apartments: 'apartments',
  coal_mine: 'mine', iron_mine: 'mine', copper_mine: 'mine', limestone_quarry: 'quarry', sand_pit: 'quarry', oil_well: 'oil',
  mill: 'mill', food_factory: 'factory', steel_mill: 'factory', refinery: 'factory', cement_works: 'factory', glassworks: 'factory',
  smelter: 'factory', sawmill: 'factory', furniture_factory: 'factory', electronics_plant: 'factory', port: 'port', bank: 'bank',
};

export const FITOUT_ICON: Record<string, string> = {
  counter: 'counter', table2: 'table', table4: 'table', booth: 'booth', kitchen: 'stove', coffee_machine: 'espresso', shelf: 'shelf',
  fridge: 'fridge', display: 'display', plant: 'plant', art: 'art', lighting: 'lamp', safe: 'safe',
};

export const NOTIFY_ICON: Record<string, string> = {
  stock: 'box', business: 'shop', order: 'market', badge: 'medal', tier: 'star', tenant: 'apartments', property: 'land', shipment: 'ship',
  friend: 'handshake', referral: 'gift', board: 'doc', moderation: 'staff', bank: 'bank', shares: 'chart', sales: 'coin',
};

export function spriteMarkup(): string {
  const ui = Object.entries(UI_ICONS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`)
    .join('');
  const goods = Object.entries(GOOD_ICONS).map(([k, v]) => `<symbol id="g-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('');
  return ui + goods;
}
