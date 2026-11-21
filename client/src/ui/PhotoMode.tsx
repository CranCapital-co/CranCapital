import { useEffect, useState } from 'react';
import { useGame } from '../lib/store';
import { sound } from '../audio/sound';
import { Icon } from './Icon';
import type { MapApi } from '../map/GameMap';

const FILTERS: [string, string, string][] = [
  ['none', 'Natural', 'none'],
  ['warm', 'Warm', 'sepia(.25) saturate(1.25) brightness(1.04)'],
  ['vivid', 'Vivid', 'saturate(1.5) contrast(1.08)'],
  ['film', 'Film', 'contrast(1.1) saturate(.85) sepia(.12)'],
  ['mono', 'Mono', 'grayscale(1) contrast(1.1)'],
];

// Photo mode: the interface hides, the camera moves freely (drag, pinch,
// two-finger tilt), you can slide the time of day and pick a filter, then
// save a picture.
export function PhotoMode({ api, onClose }: { api: React.MutableRefObject<MapApi | null>; onClose: () => void }) {
  const [hour, setHour] = useState<number | null>(null);
  const [filter, setFilter] = useState('none');
  const css = FILTERS.find((f) => f[0] === filter)![2];
  useEffect(() => {
    document.documentElement.style.setProperty('--photo-filter', css);
  }, [css]);
  useEffect(() => {
    useGame.getState().close();
    const map = api.current?.map;
    map?.setMaxPitch?.(85);
    return () => {
      api.current?.setPhotoHour(null);
      document.documentElement.style.removeProperty('--photo-filter');
      map?.setMaxPitch?.(70);
    };
  }, []);
  const save = async () => {
    const url = await api.current?.snapshot();
    if (!url) return useGame.getState().toast('Couldn’t take the picture on this device.', 'error');
    // Bake the filter into the picture where the browser can.
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    if ('filter' in ctx) ctx.filter = css;
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    ctx.font = `600 ${Math.round(c.width / 60)}px Fraunces, serif`;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = 8;
    ctx.fillText('CranCapital', c.width * 0.025, c.height * 0.96);
    const out = c.toDataURL('image/png');
    sound.play('success');
    const blob = await (await fetch(out)).blob();
    const file = new File([blob], 'crancapital.png', { type: 'image/png' });
    // iPad: the share sheet lets you save to Photos; elsewhere, download.
    if ((navigator as any).canShare?.({ files: [file] })) {
      try {
        await (navigator as any).share({ files: [file], title: 'CranCapital' });
        return;
      } catch {
        /* cancelled: fall back to download */
      }
    }
    const a = document.createElement('a');
    a.href = out;
    a.download = 'crancapital.png';
    a.click();
  };
  return (
    <div className="photo-bar" role="toolbar" aria-label="Photo mode">
      <label className="photo-time">
        <Icon name={hour != null && (hour < 6 || hour > 19) ? 'moon' : 'sun'} size={20} />
        <input
          type="range"
          min={0}
          max={24}
          step={0.25}
          value={hour ?? new Date().getHours()}
          onChange={(e) => {
            const h = Number(e.target.value);
            setHour(h);
            api.current?.setPhotoHour(h);
          }}
          aria-label="Time of day"
        />
        <span className="tnum small">{hour == null ? 'Now' : `${String(Math.floor(hour) % 24).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`}</span>
      </label>
      <div className="photo-filters">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <div className="row">
        <button className="btn gold" onClick={save}><Icon name="camera" /> Save picture</button>
        <button className="btn ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
