// Launch cities for CranCapital. Each city has a playable core (bbox) that is
// turned into game data by build.mjs. Bounding boxes are [west, south, east, north].
//
// Climate decides which crops grow there (bananas and coffee need "warm").
// travelHub is where you arrive after a flight.

export const CITIES = [
  {
    id: 'london',
    name: 'London',
    country: 'United Kingdom',
    tz: 'Europe/London',
    climate: 'temperate',
    currency: 'GBP',
    bbox: [-0.1650, 51.4930, -0.0700, 51.5280],
    start: { lng: -0.1281, lat: 51.5080, label: 'Trafalgar Square' },
    travelHub: { lng: -0.1235, lat: 51.5308, label: 'King’s Cross' },
  },
  {
    id: 'new-york',
    name: 'New York',
    country: 'United States',
    tz: 'America/New_York',
    climate: 'temperate',
    currency: 'USD',
    bbox: [-74.0190, 40.7020, -73.9600, 40.7700],
    start: { lng: -73.9855, lat: 40.7580, label: 'Times Square' },
    travelHub: { lng: -73.9772, lat: 40.7527, label: 'Grand Central' },
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    country: 'Japan',
    tz: 'Asia/Tokyo',
    climate: 'temperate',
    currency: 'JPY',
    bbox: [139.7350, 35.6560, 139.7880, 35.6990],
    start: { lng: 139.7671, lat: 35.6812, label: 'Tokyo Station' },
    travelHub: { lng: 139.7671, lat: 35.6812, label: 'Tokyo Station' },
  },
  {
    id: 'singapore',
    name: 'Singapore',
    country: 'Singapore',
    tz: 'Asia/Singapore',
    climate: 'warm',
    currency: 'SGD',
    bbox: [103.8320, 1.2680, 103.8720, 1.3080],
    start: { lng: 103.8515, lat: 1.2839, label: 'Raffles Place' },
    travelHub: { lng: 103.8545, lat: 1.2931, label: 'City Hall' },
  },
];

// Grid resolutions in metres.
export const GRID = {
  walk: 5, // walkable street bitmap (cart placement)
  plot: 25, // buildable land plots
  traffic: 50, // foot traffic scores
};
