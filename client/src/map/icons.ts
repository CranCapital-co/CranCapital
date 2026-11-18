// Map icons drawn in code: business badges and player avatars. Generated on
// demand (MapLibre asks through 'styleimagemissing').
import type { Map as MLMap } from 'maplibre-gl';
import { RING_COLORS } from '../lib/format';

export const SKINS: Record<string, { body: string; accent: string; pattern?: 'stripe' | 'dots' | 'shine' | 'marble' }> = {
  classic: { body: '#2f6f5e', accent: '#f2c14b' },
  mint: { body: '#5cc8a6', accent: '#ffffff' },
  coral: { body: '#e3694d', accent: '#ffe2b3' },
  sky: { body: '#3f8ed6', accent: '#e3f2ff' },
  sunny: { body: '#f3c443', accent: '#7a4b00' },
  night: { body: '#2b2f4a', accent: '#9aa7ff' },
  sprout: { body: '#7cb34a', accent: '#f4f9e8', pattern: 'dots' },
  graduate: { body: '#1d1d2b', accent: '#f2c14b', pattern: 'stripe' },
  hardhat: { body: '#f2a12b', accent: '#2a2a2a', pattern: 'stripe' },
  captain: { body: '#1f3f73', accent: '#ffffff', pattern: 'stripe' },
  tycoon: { body: '#134d3b', accent: '#f2c14b', pattern: 'shine' },
  gilded: { body: '#d8a531', accent: '#fff3c4', pattern: 'shine' },
  neon: { body: '#b03ad6', accent: '#47f5d0', pattern: 'dots' },
  marble: { body: '#e8e4dc', accent: '#8c8579', pattern: 'marble' },
};

export const BUSINESS_COLORS: Record<number, string> = {
  1: '#e3694d',
  2: '#2f8f6e',
  3: '#6c9a3d',
  4: '#8a6b4a',
  5: '#4b6a8c',
  6: '#6b4b8c',
};

const DPR = 2;

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = size * DPR;
  c.height = size * DPR;
  const ctx = c.getContext('2d')!;
  ctx.scale(DPR, DPR);
  return { c, ctx };
}

export function drawAvatar(ctx: CanvasRenderingContext2D, size: number, skin: string, ring: string, ringStyle = 'standard') {
  const s = SKINS[skin] ?? SKINS.classic;
  const r = size / 2;
  ctx.clearRect(0, 0, size, size);
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(r, size * 0.88, r * 0.55, r * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Ring
  const ringColor = RING_COLORS[ring] ?? RING_COLORS.none;
  ctx.lineWidth = ring === 'none' ? 2.5 : 4;
  ctx.strokeStyle = ringColor;
  ctx.beginPath();
  ctx.arc(r, r * 0.86, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  if (ringStyle === 'double' && ring !== 'none') {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(r, r * 0.86, r * 0.86, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Body
  ctx.fillStyle = s.body;
  ctx.beginPath();
  ctx.arc(r, r * 0.86, r * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r * 0.86, r * 0.58, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = s.accent;
  if (s.pattern === 'stripe') ctx.fillRect(0, r * 0.62, size, r * 0.18);
  if (s.pattern === 'dots') for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(r * (0.55 + 0.18 * (i % 3)), r * (0.62 + 0.3 * Math.floor(i / 3)), r * 0.06, 0, 7); ctx.fill(); }
  if (s.pattern === 'shine') { ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.ellipse(r * 0.8, r * 0.6, r * 0.18, r * 0.32, -0.6, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
  if (s.pattern === 'marble') { ctx.strokeStyle = s.accent; ctx.lineWidth = 1; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, r * (0.4 + i * 0.25)); ctx.bezierCurveTo(r * 0.6, r * (0.2 + i * 0.3), r * 1.2, r * (0.7 + i * 0.2), size, r * (0.5 + i * 0.25)); ctx.stroke(); } }
  ctx.restore();
  // Face
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(r * 0.82, r * 0.8, r * 0.11, 0, 7); ctx.arc(r * 1.18, r * 0.8, r * 0.11, 0, 7); ctx.fill();
  ctx.fillStyle = '#1b1b1b';
  ctx.beginPath(); ctx.arc(r * 0.84, r * 0.82, r * 0.05, 0, 7); ctx.arc(r * 1.2, r * 0.82, r * 0.05, 0, 7); ctx.fill();
}

export function avatarDataUrl(skin: string, ring: string, size = 56, ringStyle = 'standard') {
  const { c, ctx } = canvas(size);
  drawAvatar(ctx, size, skin, ring, ringStyle);
  return c.toDataURL();
}

// A round badge in the tier colour (gold rim if it's yours) holding a
// picture of the business's 3D model once that has been rendered.
function businessIcon(color: string, mine: boolean, dim: boolean, pic?: HTMLImageElement) {
  const size = 44;
  const { c, ctx } = canvas(size);
  const r = size / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.arc(r, r + 1.5, r - 3, 0, 7); ctx.fill();
  ctx.fillStyle = dim ? '#8c918f' : '#fffdf8';
  ctx.beginPath(); ctx.arc(r, r, r - 3, 0, 7); ctx.fill();
  ctx.lineWidth = mine ? 4.5 : 3;
  ctx.strokeStyle = mine ? '#f2c14b' : color;
  ctx.stroke();
  if (pic) {
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r - 5, 0, 7); ctx.clip();
    if (dim) ctx.globalAlpha = 0.55;
    ctx.drawImage(pic, 4, 4, size - 8, size - 8);
    ctx.restore();
  } else {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(r, r, r * 0.32, 0, 7); ctx.fill();
  }
  void c;
  return ctx.getImageData(0, 0, size * DPR, size * DPR);
}

// Image ids: "bz:<icon>:<tier>:<mine 0|1>:<dim 0|1>" and "av:<skin>:<ring>:<style>".
export function installIconFactory(map: MLMap) {
  map.on('styleimagemissing', (e) => {
    const id = e.id as string;
    if (map.hasImage(id)) return;
    if (id.startsWith('bz:')) {
      const [, kind, tier, mine, dim] = id.split(':');
      const color = BUSINESS_COLORS[Number(tier)] ?? '#555';
      map.addImage(id, businessIcon(color, mine === '1', dim === '1'), { pixelRatio: DPR });
      import('../world3d/thumbs')
        .then((m) => m.businessThumb(kind, Number(tier) || 1))
        .then((url) => {
          if (!url) return;
          const img = new Image();
          img.onload = () => {
            if (map.hasImage(id)) map.updateImage(id, businessIcon(color, mine === '1', dim === '1', img));
          };
          img.src = url;
        })
        .catch(() => {});
    } else if (id.startsWith('av:')) {
      const [, skin, ring, style] = id.split(':');
      const { ctx } = canvas(48);
      drawAvatar(ctx, 48, skin, ring, style);
      map.addImage(id, ctx.getImageData(0, 0, 48 * DPR, 48 * DPR), { pixelRatio: DPR });
    }
  });
}
