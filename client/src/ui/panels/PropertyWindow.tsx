import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, goodName } from '../../lib/store';
import { money, num } from '../../lib/format';
import { distM } from '../../lib/citydata';
import { Window, useApi, Loading, Stat, Field, DollarInput, Confirm, Money } from '../components';
import { refreshMe } from '../common';
import { BizIcon, Icon } from '../Icon';

function useNear(lat?: number, lng?: number, range = 80) {
  const pos = useGame((s) => s.pos);
  const walking = useGame((s) => s.walkingTo);
  if (!pos || lat === undefined || lng === undefined) return { near: false, dist: Infinity };
  const dist = distM(pos.lat, pos.lng, lat, lng);
  return { near: dist <= range - 5 && !walking, dist };
}

export default function PropertyWindow({ params }: { params: { building?: number; plot?: { city: string; px: number; py: number } } }) {
  if (params.building) return <BuildingView id={params.building} />;
  if (params.plot) return <PlotView {...params.plot} />;
  return null;
}

function WalkThere({ lat, lng, dist, label }: { lat: number; lng: number; dist: number; label: string }) {
  return (
    <div className="notice blue small row between">
      <span>You’re {num(dist)} m away. {label}</span>
      <button className="btn tiny" onClick={() => useGame.setState({ walkingTo: { lat, lng } })}>Walk there</button>
    </div>
  );
}

function BuildingView({ id }: { id: number }) {
  const me = useGame((s) => s.me)!;
  const { open, close } = useGame.getState();
  const cat = catalog();
  const { data: b, loading, reload } = useApi(() => rpc<any>('building_info', { p_building: id }), [id]);
  const [kind, setKind] = useState('cafe');
  const [name, setName] = useState('');
  const [rentPct, setRentPct] = useState<number | null>(null);
  const [salePrice, setSalePrice] = useState<number>(0);
  const [confirm, setConfirm] = useState<null | 'buy' | 'sell'>(null);
  const near = useNear(b?.lat, b?.lng, b?.range_m ?? 80);
  if (loading && !b) return <Window title="Building"><Loading /></Window>;
  if (!b) {
    return (
      <Window title="Building" icon="apartments">
        <p>This building isn’t part of the game yet. Only buildings inside each city’s playable area can be rented or bought.</p>
      </Window>
    );
  }
  const roomTypes = cat.business_types.filter((t) => t.placement === 'room');
  const title = b.display_name || (b.kind === 'residential' ? 'Residential building' : b.kind === 'commercial' ? 'Commercial building' : b.kind[0].toUpperCase() + b.kind.slice(1));
  const done = async () => {
    await reload();
    await refreshMe();
  };
  return (
    <Window title={title} icon={b.landmark ? 'bank' : 'apartments'}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">{b.kind}</span>
          {b.landmark && <span className="chip gold">Landmark</span>}
          {b.mine ? <span className="chip gold">Yours</span> : b.owner_name ? <span className="chip blue">Owned by {b.owner_name}</span> : <span className="chip">Owned by the city</span>}
          {b.for_sale_price && !b.mine && <span className="chip red">For sale</span>}
        </div>
        <div className="grid3">
          <Stat label="Rooms free" value={`${b.rooms_free} / ${b.rooms_total}`} />
          <Stat label="Rent" value={money(b.rent_per_day)} sub="per room per day" />
          <Stat label="Foot traffic" value={Number(b.traffic).toFixed(2)} />
        </div>
        <div className="small muted">{num(b.footprint_m2)} m² footprint · {b.levels} floors · {Number(b.height_m).toFixed(0)} m tall</div>

        {b.tenants.length > 0 && (
          <div className="card">
            <strong>Inside</strong>
            <table className="list">
              <tbody>
                {b.tenants.map((t: any) => (
                  <tr key={t.business_id} className="click" onClick={() => open('business', { id: t.business_id })}>
                    <td className="nowrap"><BizIcon kind={t.id} tier={t.tier} size={20} /> {t.name}</td>
                    <td className="small muted">{t.owner_name}</td>
                    {b.mine && <td className="r small">{money(t.rent_per_day)}/day</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!near.near && <WalkThere lat={b.lat} lng={b.lng} dist={near.dist} label="Walk up to rent or buy." />}

        {b.rooms_free > 0 && (
          <div className="card stack">
            <strong>Rent a room</strong>
            {me.tier < 2 ? (
              <p className="small muted">Unlocks at tier 2 ({money(cat.tiers[1].net_worth, { compact: true })} net worth).</p>
            ) : (
              <>
                <div className="grid2">
                  <Field label="Business">
                    <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                      {roomTypes.map((t) => (
                        <option key={t.id} value={t.id} disabled={me.tier < t.tier}>{t.name} ({money(t.cost, { compact: true })}){me.tier < t.tier ? ` · tier ${t.tier}` : ''}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Name">
                    <input className="input" value={name} placeholder={`${me.display_name}'s ${roomTypes.find((t) => t.id === kind)?.name}`} maxLength={40} onChange={(e) => setName(e.target.value)} />
                  </Field>
                </div>
                <p className="tiny muted">{roomTypes.find((t) => t.id === kind)?.description} You pay the licence now, the first day’s rent, then rent every minute.</p>
                <button
                  className="btn"
                  disabled={!near.near}
                  onClick={async () => {
                    const pos = useGame.getState().pos!;
                    const r = await act(() => rpc<any>('rent_room', { p_building: b.id, p_kind: kind, p_name: name, p_lat: pos.lat, p_lng: pos.lng }), 'Room rented! Now fit it out and hire staff.');
                    if (r) {
                      window.dispatchEvent(new CustomEvent('cc:built', { detail: { id: r.business_id } }));
                      await refreshMe();
                      open('business', { id: r.business_id });
                    }
                  }}
                >
                  Rent for {money(b.rent_per_day)}/day + {money(roomTypes.find((t) => t.id === kind)?.cost ?? 0, { compact: true })} licence
                </button>
              </>
            )}
          </div>
        )}

        {!b.mine && b.price && !b.landmark && (
          <div className="card stack">
            <strong>Buy this building</strong>
            <p className="small muted">Earn rent from every tenant, and local tenants fill empty rooms. Property tax is {cat.config.property_tax_pct_day}% of the price a day.</p>
            <button className="btn gold" disabled={!near.near || me.tier < 3} onClick={() => setConfirm('buy')}>
              {me.tier < 3 ? 'Unlocks at tier 3' : `Buy for ${money(b.price)}`}
            </button>
          </div>
        )}

        {b.mine && (
          <div className="card stack">
            <strong>Your building</strong>
            {b.npc_income_per_day > 0 && <div className="small">Local tenants pay about <b>{money(b.npc_income_per_day)}</b> a day for empty rooms.</div>}
            <Field label={`Rent: ${rentPct ?? b.rent_pct}% of the going rate`} hint="Higher rent earns more per tenant but fewer local tenants move in.">
              <input type="range" min={50} max={200} step={5} value={rentPct ?? b.rent_pct} onChange={(e) => setRentPct(Number(e.target.value))} />
            </Field>
            <button className="btn small" disabled={rentPct === null || rentPct === b.rent_pct} onClick={async () => { if (await act(() => rpc('set_building', { p_building: b.id, p_rent_pct: rentPct, p_for_sale: b.for_sale_price }), 'Rent updated.')) done(); }}>
              Save rent
            </button>
            <hr className="sep" />
            {b.for_sale_price ? (
              <div className="row between">
                <span className="small">Listed for {money(b.for_sale_price)}</span>
                <button className="btn small ghost" onClick={async () => { if (await act(() => rpc('set_building', { p_building: b.id, p_for_sale: null }), 'Listing removed.')) done(); }}>Unlist</button>
              </div>
            ) : (
              <div className="row">
                <DollarInput value={salePrice || b.bought_price || 0} onChange={setSalePrice} />
                <button className="btn small" onClick={async () => { if (await act(() => rpc('set_building', { p_building: b.id, p_for_sale: salePrice || b.bought_price }), 'Listed for sale.')) done(); }}>List for sale</button>
              </div>
            )}
            <button className="btn small danger" onClick={() => setConfirm('sell')}>Sell to the city</button>
          </div>
        )}

        {confirm === 'buy' && (
          <Confirm
            title="Buy this building?"
            body={<p>You’ll pay {money(b.price)}. Existing tenants stay and pay you rent.</p>}
            confirm="Buy"
            onCancel={() => setConfirm(null)}
            onConfirm={async () => {
              const pos = useGame.getState().pos!;
              const r = await act(() => rpc('buy_building', { p_building: b.id, p_lat: pos.lat, p_lng: pos.lng, p_expected_price: b.owner_name ? b.price : null }), 'It’s yours! Set the rent to suit you.');
              setConfirm(null);
              if (r) done();
            }}
          />
        )}
        {confirm === 'sell' && (
          <Confirm
            title="Sell to the city?"
            body={<p>The city pays 70% of what it’s worth (at most 70% of what you paid). This can’t be undone.</p>}
            confirm="Sell"
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={async () => {
              const r = await act(() => rpc<any>('sell_building_to_city', { p_building: b.id }), (x) => `Sold for ${money(x.received)}.`);
              setConfirm(null);
              if (r) { await refreshMe(); close(); }
            }}
          />
        )}
      </div>
    </Window>
  );
}

function PlotView({ city, px, py }: { city: string; px: number; py: number }) {
  const me = useGame((s) => s.me)!;
  const { open, close } = useGame.getState();
  const cat = catalog();
  const { data: p, loading, reload } = useApi(() => rpc<any>('plot_info', { p_city: city, p_px: px, p_py: py }), [city, px, py]);
  const [kind, setKind] = useState('farm');
  const [option, setOption] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState(0);
  const near = useNear(p?.lat, p?.lng, 60);
  if (loading && !p) return <Window title="Plot"><Loading /></Window>;
  if (!p) return null;
  const climate = cat.cities.find((c) => c.id === city)?.climate;
  const done = async () => {
    await reload();
    await refreshMe();
    useGame.getState().bump();
  };
  const buildable = cat.business_types.filter((t) =>
    t.placement === 'plot' || (t.placement === 'coastal' && p.coastal) || (t.placement === 'deposit' && p.deposit && t.resource === p.deposit.resource)
  );
  const sel = cat.business_types.find((t) => t.id === kind);
  return (
    <Window title={`Plot ${px}·${py}`} icon="land">
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">25 × 25 m</span>
          {p.coastal && <span className="chip blue">By the water</span>}
          {p.mine ? <span className="chip gold">Yours</span> : p.owner_name ? <span className="chip blue">Owned by {p.owner_name}</span> : <span className="chip green">For sale by the city</span>}
        </div>
        <div className="grid3">
          <Stat label="Foot traffic" value={Number(p.traffic).toFixed(2)} />
          <Stat label="Price" value={p.price ? <Money v={p.price} /> : '—'} />
          <Stat label="Survey" value={p.surveyed ? 'Done' : 'Not yet'} />
        </div>
        {p.deposit && (
          <div className="notice gold small"><Icon name="mine" size={16} /> {goodName(p.deposit.resource)} deposit under this plot: {num(p.deposit.units_left)} units left.</div>
        )}
        {p.business && (
          <button className="card click row between" onClick={() => open('business', { id: p.business.id })}>
            <span className="row"><BizIcon kind={p.business.kind} size={20} /> {p.business.name}</span>
            <span className="chip">{p.business.type_name}</span>
          </button>
        )}
        {!p.owner_name && (
          <div className="card stack">
            <strong>Buy this plot</strong>
            {!near.near && <WalkThere lat={p.lat} lng={p.lng} dist={near.dist} label="Stand on a plot to buy it." />}
            <button
              className="btn gold"
              disabled={!near.near || me.tier < 3}
              onClick={async () => {
                const pos = useGame.getState().pos!;
                if (await act(() => rpc('buy_plot', { p_city: city, p_px: px, p_py: py, p_lat: pos.lat, p_lng: pos.lng }), 'Plot bought! Now build on it.')) done();
              }}
            >
              {me.tier < 3 ? `Unlocks at tier 3 (${money(cat.tiers[2].net_worth, { compact: true })})` : `Buy for ${money(p.price)}`}
            </button>
          </div>
        )}
        {p.owner_name && !p.mine && p.for_sale_price && (
          <div className="card stack">
            <strong>Listed for {money(p.for_sale_price)}</strong>
            <button className="btn gold" disabled={me.tier < 3} onClick={async () => { if (await act(() => rpc('buy_listed_plot', { p_city: city, p_px: px, p_py: py, p_expected_price: p.for_sale_price }), 'Plot bought!')) done(); }}>
              Buy from {p.owner_name}
            </button>
          </div>
        )}
        {p.mine && !p.business && (
          <div className="card stack">
            <strong>Build here</strong>
            <Field label="What">
              <select className="input" value={kind} onChange={(e) => { setKind(e.target.value); setOption(''); }}>
                {buildable.map((t) => (
                  <option key={t.id} value={t.id} disabled={me.tier < t.tier}>
                    <BizIcon kind={t.id} tier={t.tier} size={18} /> {t.name} · {money(t.cost, { compact: true })}{me.tier < t.tier ? ` (tier ${t.tier})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            {sel?.produces === 'crop' && (
              <Field label="Crop">
                <select className="input" value={option} onChange={(e) => setOption(e.target.value)}>
                  <option value="">Choose…</option>
                  {Object.keys(cat.crops).map((g) => {
                    const good = cat.goods.find((x) => x.id === g)!;
                    return <option key={g} value={g} disabled={good.warm_only && climate !== 'warm'}>{good.name}{good.warm_only && climate !== 'warm' ? ' (warm cities only)' : ''}</option>;
                  })}
                </select>
              </Field>
            )}
            <Field label="Name">
              <input className="input" value={name} maxLength={40} placeholder={`${me.display_name}'s ${sel?.name ?? ''}`} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p className="tiny muted">{sel?.description}</p>
            <button
              className="btn"
              disabled={!sel || me.tier < sel.tier || (sel.produces === 'crop' && !option)}
              onClick={async () => {
                const r = await act(() => rpc<any>('build_on_plot', { p_city: city, p_px: px, p_py: py, p_kind: kind, p_name: name, p_option: option || null }), `${sel?.name} built!`);
                if (r) { window.dispatchEvent(new CustomEvent('cc:built', { detail: { id: r.business_id } })); await done(); open('business', { id: r.business_id }); }
              }}
            >
              Build for {money(sel?.cost ?? 0)}
            </button>
          </div>
        )}
        {p.mine && (
          <div className="card stack">
            {p.for_sale_price ? (
              <div className="row between">
                <span className="small">Listed for {money(p.for_sale_price)}</span>
                <button className="btn small ghost" onClick={async () => { if (await act(() => rpc('set_plot_sale', { p_city: city, p_px: px, p_py: py, p_price: null }), 'Listing removed.')) done(); }}>Unlist</button>
              </div>
            ) : (
              <div className="row">
                <DollarInput value={price || p.bought_price || 0} onChange={setPrice} />
                <button className="btn small" onClick={async () => { if (await act(() => rpc('set_plot_sale', { p_city: city, p_px: px, p_py: py, p_price: price || p.bought_price }), 'Listed for sale.')) done(); }}>List for sale</button>
              </div>
            )}
            {!p.business && (
              <button className="btn small danger" onClick={async () => { const r = await act(() => rpc<any>('sell_plot_to_city', { p_city: city, p_px: px, p_py: py }), (x) => `Sold for ${money(x.received)}.`); if (r) { await refreshMe(); close(); } }}>
                Sell to the city (70%)
              </button>
            )}
          </div>
        )}
      </div>
    </Window>
  );
}
