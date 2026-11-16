import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, goodName, goodIcon, cityName } from '../../lib/store';
import { money, unitPrice, hourLabel, num, ago } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Money, Stat, Bars, Confirm, Field, DollarInput, Progress } from '../components';
import { refreshMe, flagList, demandAt } from '../common';
import type { Business } from '../../lib/types';

type Tab = 'overview' | 'menu' | 'stock' | 'fitout' | 'staff' | 'production' | 'shipping' | 'bank' | 'manage';

export default function BusinessWindow({ params }: { params: { id: number } }) {
  const me = useGame((s) => s.me)!;
  const { data: b, loading, reload } = useApi(() => rpc<Business & { mine?: boolean }>('business_detail', { p_id: params.id }), [params.id], 20000);
  const [tab, setTab] = useState<Tab>('overview');
  if (loading && !b) return <Window title="Business"><Loading /></Window>;
  if (!b) return <Window title="Business">Not found.</Window>;
  const t = catalog().business_types.find((x) => x.id === b.kind)!;
  const mine = b.owner_no === me.player_no;
  if (!mine) return <ShopFront b={b} />;

  const customer = !!t.menu_category && t.id !== 'bank';
  const tabs: [Tab, string][] = [['overview', 'Overview']];
  if (customer) tabs.push(['menu', 'Menu'], ['stock', 'Stock']);
  if (t.placement === 'room' && t.id !== 'bank') tabs.push(['fitout', 'Fit-out'], ['staff', 'Staff & hours']);
  if (t.placement === 'street') tabs.push(['staff', 'Hours']);
  if (!customer && t.id !== 'port' && t.id !== 'bank') tabs.push(['production', 'Production']);
  if (t.id === 'port') tabs.push(['shipping', 'Shipping']);
  if (t.id === 'bank') tabs.push(['bank', 'Bank']);
  tabs.push(['manage', 'Manage']);

  const done = async () => {
    await reload();
    await refreshMe();
  };

  return (
    <Window title={b.name} icon={b.icon}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">{t.name}</span>
          <span className="chip">Level {b.level}</span>
          <span className="chip">{cityName(b.city_id)}</span>
          <button
            className={`chip ${b.status === 'open' ? 'green' : 'red'}`}
            style={{ border: 0, cursor: 'pointer' }}
            onClick={async () => {
              if (await act(() => rpc('set_business_open', { p_id: b.id, p_open: b.status !== 'open' }), b.status === 'open' ? 'Closed.' : 'Open again.')) done();
            }}
            title="Open or close"
          >
            {b.status === 'open' ? '● Open' : '○ Closed'} — tap to {b.status === 'open' ? 'close' : 'open'}
          </button>
        </div>
        {flagList(b.flags).map((f) => <div key={f} className="notice red small">{f}{f === 'Fit-out incomplete' && b.flags.missing ? `: needs ${b.flags.missing.join(', ')}` : ''}</div>)}
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        {tab === 'overview' && <Overview b={b} t={t} />}
        {tab === 'menu' && <MenuEditor b={b} onSaved={done} />}
        {tab === 'stock' && <StockTab b={b} />}
        {tab === 'fitout' && <FitoutEditor b={b} onSaved={done} />}
        {tab === 'staff' && <StaffTab b={b} t={t} onSaved={done} />}
        {tab === 'production' && <ProductionTab b={b} t={t} onSaved={done} />}
        {tab === 'shipping' && <ShippingTab b={b} />}
        {tab === 'bank' && <BankTab b={b} />}
        {tab === 'manage' && <ManageTab b={b} t={t} onSaved={done} />}
      </div>
    </Window>
  );
}

function Overview({ b, t }: { b: Business; t: any }) {
  const hist = [...(b.history ?? [])].reverse();
  const isProducer = !t.menu_category;
  return (
    <div className="stack">
      <div className="grid3">
        <Stat label={isProducer ? 'Made today' : 'Sales today'} value={num(isProducer ? b.produced_today : b.sales_today)} />
        <Stat label="Income today" value={<Money v={b.revenue_today} />} />
        <Stat label="Costs today" value={<Money v={b.costs_today} />} />
      </div>
      {t.menu_category && t.id !== 'bank' && (
        <div className="grid3">
          <Stat label="Foot traffic" value={Number(b.traffic).toFixed(2)} sub="1.0 is a normal street" />
          <Stat label="Can serve" value={`${num(b.capacity)}/h`} sub="customers per hour" />
          <Stat label="Hours" value={b.open_hour === b.close_hour || (b.open_hour === 0 && b.close_hour === 24) ? '24 h' : `${b.open_hour}–${b.close_hour}`} sub={`now ${b.local_hour}:00 local`} />
        </div>
      )}
      {b.lease && (
        <div className="card soft small">
          Room at <b>{b.lease.building_name ?? 'a building'}</b> · rent {money(b.lease.rent_per_day)} a day
          {b.lease.landlord ? ` to ${b.lease.landlord}` : ' to the city'}
          {b.lease.unpaid > 0 && <span className="bad"> · {money(b.lease.unpaid)} overdue</span>}
        </div>
      )}
      {hist.length > 1 && (
        <div className="card">
          <div className="small muted" style={{ marginBottom: 6 }}>Income by day (last {hist.length} days)</div>
          <Bars values={hist.map((h) => h.revenue)} labels={hist.map((h) => new Date(h.day).toLocaleDateString('en-GB', { day: 'numeric' }))} format={(v) => money(v)} />
        </div>
      )}
      <div className="small muted">
        Lifetime income {money(b.lifetime_revenue)} · book value {money(b.book_value)}
      </div>
    </div>
  );
}

function MenuEditor({ b, onSaved }: { b: Business; onSaved: () => void }) {
  const cat = catalog();
  const t = cat.business_types.find((x) => x.id === b.kind)!;
  const options = cat.menu_items.filter((m) => m.category === t.menu_category);
  const [menu, setMenu] = useState<{ id: string; price: number }[]>(b.settings?.menu ?? []);
  const slots = b.menu_slots ?? 3;
  const dirty = JSON.stringify(menu) !== JSON.stringify(b.settings?.menu ?? []);
  return (
    <div className="stack">
      <p className="small muted">
        Up to {slots} items. Customers compare your price with the fair price: cheaper sells more, pricier sells less but earns more per sale.
      </p>
      {menu.map((it, i) => {
        const mi = options.find((o) => o.id === it.id)!;
        if (!mi) return null;
        const d = demandAt(it.price, mi.fair_price);
        const ratio = it.price / mi.fair_price;
        return (
          <div key={it.id} className="menu-row">
            <span style={{ fontSize: 22 }}>{mi.icon}</span>
            <div className="stack tight">
              <div className="row between">
                <strong>{mi.name}</strong>
                <span className="tiny muted">fair {money(mi.fair_price)}</span>
              </div>
              <input
                type="range"
                min={Math.round(mi.fair_price * 0.4)}
                max={Math.round(mi.fair_price * 2)}
                step={Math.max(10, Math.round(mi.fair_price / 100))}
                value={it.price}
                onChange={(e) => setMenu(menu.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))}
                aria-label={`${mi.name} price`}
              />
              <div className="demand" title="Customer interest"><i style={{ left: `${Math.min(98, Math.max(0, ((ratio - 0.4) / 1.6) * 100))}%` }} /></div>
              <div className="tiny muted">
                {Object.entries(mi.ingredients).map(([g, q]) => `${q} ${goodName(g).toLowerCase()}`).join(', ')} · interest {(d * 100).toFixed(0)}%
              </div>
            </div>
            <div className="stack tight" style={{ alignItems: 'flex-end' }}>
              <DollarInput value={it.price} onChange={(v) => setMenu(menu.map((x, j) => (j === i ? { ...x, price: v } : x)))} />
              <button className="link tiny" onClick={() => setMenu(menu.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
        );
      })}
      {menu.length < slots && (
        <select
          className="input"
          value=""
          onChange={(e) => {
            const mi = options.find((o) => o.id === e.target.value);
            if (mi) setMenu([...menu, { id: mi.id, price: mi.fair_price }]);
          }}
        >
          <option value="">+ Add an item…</option>
          {options.filter((o) => !menu.some((m) => m.id === o.id)).map((o) => (
            <option key={o.id} value={o.id}>{o.icon} {o.name} (fair {money(o.fair_price)})</option>
          ))}
        </select>
      )}
      <button className="btn" disabled={!dirty} onClick={async () => { if (await act(() => rpc('set_menu', { p_id: b.id, p_menu: menu }), 'Menu saved.')) onSaved(); }}>
        Save menu
      </button>
    </div>
  );
}

function StockTab({ b }: { b: Business }) {
  const cat = catalog();
  const { data: storage, reload } = useApi(() => rpc<any[]>('my_storage'), []);
  const { data: market } = useApi(() => rpc<any[]>('market_overview'), []);
  const [servings, setServings] = useState(200);
  const menu: { id: string }[] = b.settings?.menu ?? [];
  const needs = useMemo(() => {
    const per: Record<string, number> = {};
    for (const m of menu) {
      const mi = cat.menu_items.find((x) => x.id === m.id);
      if (!mi) continue;
      for (const [g, q] of Object.entries(mi.ingredients)) per[g] = Math.max(per[g] ?? 0, q);
    }
    return per;
  }, [menu, cat]);
  const have = (g: string) => storage?.find((s) => s.city_id === b.city_id)?.goods.find((x: any) => x.good === g)?.qty ?? 0;
  const ask = (g: string) => market?.find((m) => m.good === g)?.ask ?? cat.goods.find((x) => x.id === g)?.base_price ?? 0;
  const goods = Object.keys(needs);
  const toBuy = goods.map((g) => ({ g, qty: Math.max(0, needs[g] * servings * Math.max(1, menu.length) - have(g)) }));
  const est = toBuy.reduce((a, x) => a + x.qty * ask(x.g), 0);
  if (!goods.length) return <p className="muted">Add items to the menu first.</p>;
  return (
    <div className="stack">
      <p className="small muted">Ingredients come from your storage in {cityName(b.city_id)}. Sales stop when one runs out.</p>
      <table className="list">
        <thead><tr><th>Ingredient</th><th className="r">In storage</th><th className="r">Per sale</th><th className="r">Price</th></tr></thead>
        <tbody>
          {goods.map((g) => (
            <tr key={g}>
              <td>{goodIcon(g)} {goodName(g)}</td>
              <td className={`r num ${have(g) < needs[g] * 20 ? 'bad' : ''}`}>{num(have(g))}</td>
              <td className="r num">{needs[g]}</td>
              <td className="r num">{unitPrice(ask(g))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card soft stack">
        <Field label={`Restock for about ${num(servings)} sales of each item`}>
          <input type="range" min={50} max={3000} step={50} value={servings} onChange={(e) => setServings(Number(e.target.value))} />
        </Field>
        <div className="row between small">
          <span>{toBuy.filter((x) => x.qty > 0).map((x) => `${num(x.qty)} ${goodName(x.g).toLowerCase()}`).join(', ') || 'You have enough already.'}</span>
          <b>≈ {money(est)}</b>
        </div>
        <button
          className="btn"
          disabled={est <= 0}
          onClick={async () => {
            let spent = 0;
            for (const x of toBuy) {
              if (x.qty <= 0) continue;
              const r = await act(() => rpc<any>('place_order', { p_good: x.g, p_side: 'buy', p_qty: x.qty, p_city: b.city_id }));
              if (!r) break;
              spent += r.value;
            }
            if (spent) useGame.getState().toast(`Restocked for ${money(spent)} from the exchange.`, 'success');
            await reload();
            await refreshMe();
          }}
        >
          Buy from the exchange
        </button>
      </div>
    </div>
  );
}

function FitoutEditor({ b, onSaved }: { b: Business; onSaved: () => void }) {
  const cat = catalog();
  const t = cat.business_types.find((x) => x.id === b.kind)!;
  const items = cat.fitout_items.filter((f) => (f.cap[t.menu_category!] ?? 0) > 0 || f.decor > 0 || f.required_for.includes(t.menu_category!));
  const initial = useMemo(() => {
    const g: (string | null)[] = Array(40).fill(null);
    (b.fitout ?? []).forEach((x, i) => (g[i] = x));
    return g;
  }, [b.fitout]);
  const [grid, setGrid] = useState<(string | null)[]>(initial);
  const [brush, setBrush] = useState<string | null>(items[0]?.id ?? null);
  const count = (g: (string | null)[]) => g.reduce<Record<string, number>>((a, x) => (x ? { ...a, [x]: (a[x] ?? 0) + 1 } : a), {});
  const before = count(initial);
  const after = count(grid);
  let cost = 0;
  let refund = 0;
  for (const f of cat.fitout_items) {
    const d = (after[f.id] ?? 0) - (before[f.id] ?? 0);
    if (d > 0) cost += d * f.cost;
    else refund += (-d * f.cost) / 2;
  }
  const cap = cat.fitout_items.reduce((a, f) => a + (after[f.id] ?? 0) * (f.cap[t.menu_category!] ?? 0), 0);
  const decor = cat.fitout_items.reduce((a, f) => a + (after[f.id] ?? 0) * f.decor, 0);
  const missing = cat.fitout_items.filter((f) => f.required_for.includes(t.menu_category!) && !after[f.id]);
  return (
    <div className="stack">
      <p className="small muted">Pick an item, then tap tiles to place it. Tap a filled tile with the eraser to remove it (you get half the price back).</p>
      <div className="palette">
        <button className={brush === null ? 'on' : ''} onClick={() => setBrush(null)}>🧽 Eraser</button>
        {items.map((f) => (
          <button key={f.id} className={brush === f.id ? 'on' : ''} onClick={() => setBrush(f.id)} title={`${f.name}: ${money(f.cost)}`}>
            <span style={{ fontSize: 18 }}>{f.icon}</span>
            <span>
              {f.name}
              <br />
              <span className="muted">{money(f.cost, { cents: false })}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="fitgrid" role="grid" aria-label="Room layout, 8 by 5 tiles">
        {grid.map((x, i) => (
          <button
            key={i}
            className={x ? 'filled' : ''}
            onClick={() => setGrid(grid.map((y, j) => (j === i ? (brush && y === brush ? null : brush) : y)))}
            aria-label={x ? cat.fitout_items.find((f) => f.id === x)?.name : 'Empty tile'}
          >
            {x ? cat.fitout_items.find((f) => f.id === x)?.icon : ''}
          </button>
        ))}
      </div>
      <div className="grid3">
        <Stat label="Room capacity" value={`${num(cap)}/h`} sub="before staff limits" />
        <Stat label="Decor" value={`+${Math.min(50, decor * 6).toFixed(0)}%`} sub="appeal (max 50%)" />
        <Stat label="Change" value={<Money v={-(cost - refund)} sign />} />
      </div>
      {missing.length > 0 && <div className="notice small">Still needs: {missing.map((m) => m.name).join(', ')}.</div>}
      <button
        className="btn"
        disabled={JSON.stringify(grid) === JSON.stringify(initial)}
        onClick={async () => {
          const last = grid.reduce((a, x, i) => (x ? i : a), -1);
          if (await act(() => rpc('set_fitout', { p_id: b.id, p_items: grid.slice(0, last + 1) }), 'Fit-out saved.')) onSaved();
        }}
      >
        Save fit-out
      </button>
    </div>
  );
}

function StaffTab({ b, t, onSaved }: { b: Business; t: any; onSaved: () => void }) {
  const [staff, setStaff] = useState(b.staff);
  const [open, setOpen] = useState(b.open_hour);
  const [close, setClose] = useState(b.close_hour);
  const hours = open === close || (open === 0 && close === 24) ? 24 : (close - open + 24) % 24;
  return (
    <div className="stack">
      {t.placement === 'room' && (
        <div className="card stack">
          <Field label={`Staff: ${staff} of ${b.max_staff}`} hint={`Each serves about ${t.per_staff} customers an hour. Wage ${money(b.wage_per_hour ?? 0)} an hour each, paid only while open.`}>
            <input type="range" min={0} max={Math.max(0, b.max_staff)} value={staff} onChange={(e) => setStaff(Number(e.target.value))} />
          </Field>
          <div className="small">Daily wages at these hours: <b>{money(staff * (b.wage_per_hour ?? 0) * hours)}</b></div>
          {b.max_staff === 0 && <div className="notice small">Add fit-out (counters, kitchens, shelves) to make room for staff.</div>}
          <button className="btn" disabled={staff === b.staff} onClick={async () => { if (await act(() => rpc('set_staff', { p_id: b.id, p_staff: staff }), 'Staff updated.')) onSaved(); }}>
            Save staff
          </button>
        </div>
      )}
      <div className="card stack">
        <strong>Opening hours (local time)</strong>
        <div className="grid2">
          <Field label="Opens">
            <select className="input" value={open} onChange={(e) => setOpen(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </Field>
          <Field label="Closes">
            <select className="input" value={close} onChange={(e) => setClose(Number(e.target.value))}>
              {Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </Field>
        </div>
        <p className="tiny muted">Same open and close time means open all day. Carts and cafés do best in the morning and at lunch, restaurants in the evening.</p>
        <button className="btn" disabled={open === b.open_hour && close === b.close_hour} onClick={async () => { if (await act(() => rpc('set_hours', { p_id: b.id, p_open: open, p_close: close }), 'Hours saved.')) onSaved(); }}>
          Save hours
        </button>
      </div>
    </div>
  );
}

function ProductionTab({ b, t, onSaved }: { b: Business; t: any; onSaved: () => void }) {
  const cat = catalog();
  const city = cat.cities.find((c) => c.id === b.city_id);
  const { data: storage } = useApi(() => rpc<any[]>('my_storage'), []);
  const have = (g: string) => storage?.find((s) => s.city_id === b.city_id)?.goods.find((x: any) => x.good === g)?.qty ?? 0;
  const mult = 1 + 0.8 * (b.level - 1);
  const auto = !!b.settings?.auto_sell;
  const recipe = t.recipe ? cat.recipes.find((r) => r.id === t.recipe) : null;
  return (
    <div className="stack">
      {t.produces === 'crop' && (
        <Field label="Crop" hint={city?.climate !== 'warm' ? 'Bananas and coffee only grow in warm cities.' : undefined}>
          <select
            className="input"
            value={b.settings?.crop}
            onChange={async (e) => {
              if (await act(() => rpc('set_business_option', { p_id: b.id, p_key: 'crop', p_value: e.target.value }), 'Crop changed.')) onSaved();
            }}
          >
            {Object.keys(cat.crops).map((g) => {
              const good = cat.goods.find((x) => x.id === g)!;
              return (
                <option key={g} value={g} disabled={good.warm_only && city?.climate !== 'warm'}>
                  {good.icon} {good.name}: {num(cat.crops[g] * mult)} an hour (≈ {money(cat.crops[g] * mult * good.base_price)}/h)
                </option>
              );
            })}
          </select>
        </Field>
      )}
      {t.produces === 'timber' && <Stat label="Timber" value={`${num(t.rate_per_hour * mult)} an hour`} />}
      {t.placement === 'deposit' && (
        <div className="card stack">
          <Stat label={`${goodName(t.resource)} dug per hour`} value={num(t.rate_per_hour * mult)} />
          {b.deposit && (
            <>
              <div className="small">Deposit left: {num(b.deposit.units_left)} of {num(b.deposit.units_total)}</div>
              <Progress value={b.deposit.units_left} max={b.deposit.units_total} color="var(--gold)" />
              <div className="tiny muted">About {Math.round(b.deposit.units_left / (t.rate_per_hour * mult))} hours of digging left.</div>
            </>
          )}
          <div className="small">Burns {b.level} diesel an hour · you have {num(have('diesel'))} in {cityName(b.city_id)}</div>
        </div>
      )}
      {recipe && (
        <div className="card stack">
          <strong>{recipe.name}</strong>
          <div className="small">
            {Object.entries(recipe.inputs).map(([g, q]) => `${q} ${goodIcon(g)} ${goodName(g)}`).join(' + ')} → {Object.entries(recipe.outputs).map(([g, q]) => `${q} ${goodIcon(g)} ${goodName(g)}`).join(' + ')}
          </div>
          <div className="small muted">Up to {num(recipe.cycles_per_hour * mult)} batches an hour{recipe.diesel_per_hour ? `, burning ${recipe.diesel_per_hour * b.level} diesel an hour` : ''}.</div>
          <table className="list">
            <thead><tr><th>Input</th><th className="r">In storage</th><th className="r">Needed per hour</th></tr></thead>
            <tbody>
              {[...Object.entries(recipe.inputs), ...(recipe.diesel_per_hour ? [['diesel', 0] as [string, number]] : [])].map(([g, q]) => (
                <tr key={g}>
                  <td>{goodIcon(g)} {goodName(g)}</td>
                  <td className="r num">{num(have(g))}</td>
                  <td className="r num">{num(g === 'diesel' ? recipe.diesel_per_hour * b.level : (q as number) * recipe.cycles_per_hour * mult)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted">Buy inputs on the exchange or make them yourself. Goods must be in storage in {cityName(b.city_id)}.</p>
        </div>
      )}
      {t.produces === 'rent' && (
        <Stat label="Apartments" value={`${num(t.rate_per_hour * b.level)} homes`} sub="Local tenants pay rent every day." />
      )}
      {t.produces === 'storage' && <Stat label="Extra storage" value={`${num(t.storage_capacity * b.level)} units`} sub={`in ${cityName(b.city_id)}`} />}
      {(t.produces === 'crop' || t.produces === 'timber' || t.produces === 'recipe' || t.placement === 'deposit') && (
        <label className="check card">
          <input
            type="checkbox"
            checked={auto}
            onChange={async (e) => {
              if (await act(() => rpc('set_business_option', { p_id: b.id, p_key: 'auto_sell', p_value: e.target.checked }), e.target.checked ? 'Output now sells automatically.' : 'Output now goes to storage.')) onSaved();
            }}
          />
          <span>
            <b>Sell output automatically</b>
            <br />
            <span className="small muted">Sells everything you make to market traders as it’s made (never below half the base price; the rest goes to storage). Handy while you’re offline.</span>
          </span>
        </label>
      )}
    </div>
  );
}

function ShippingTab({ b }: { b: Business }) {
  const cat = catalog();
  const { data: storage } = useApi(() => rpc<any[]>('my_storage'), []);
  const { data: prop, reload } = useApi(() => rpc<any>('my_property'), []);
  const goods = storage?.find((s) => s.city_id === b.city_id)?.goods ?? [];
  const [good, setGood] = useState('');
  const [qty, setQty] = useState(1000);
  const [to, setTo] = useState(cat.cities.find((c) => c.id !== b.city_id)?.id ?? '');
  const [kind, setKind] = useState<'export' | 'transfer'>('export');
  useEffect(() => {
    if ((!good || !goods.some((x: any) => x.good === good)) && goods[0]) setGood(goods[0].good);
  }, [goods, good]);
  const unit = prop?.export_prices?.[to]?.[good];
  const g = cat.goods.find((x) => x.id === good);
  return (
    <div className="stack">
      <p className="small muted">Load goods from your storage in {cityName(b.city_id)}. Exports sell to overseas buyers on arrival; transfers move goods into your own storage there.</p>
      <div className="grid2">
        <Field label="Goods">
          <select className="input" value={good} onChange={(e) => setGood(e.target.value)}>
            {goods.length === 0 && <option value="">Nothing in storage</option>}
            {goods.map((x: any) => <option key={x.good} value={x.good}>{goodIcon(x.good)} {goodName(x.good)} ({num(x.qty)})</option>)}
          </select>
        </Field>
        <Field label="Quantity">
          <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
        </Field>
        <Field label="To">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {cat.cities.filter((c) => c.id !== b.city_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)}>
            <option value="export">Export (sell there)</option>
            <option value="transfer">Transfer (keep)</option>
          </select>
        </Field>
      </div>
      {kind === 'export' && unit && g && (
        <div className="notice blue small">
          Buyers in {cityName(to)} pay about {unitPrice(unit)} each ({((unit / g.base_price) * 100 - 100).toFixed(0)}% over base) · ≈ {money(unit * qty)} before freight. Big loads push the price down.
        </div>
      )}
      <button className="btn" disabled={!good || qty <= 0} onClick={async () => {
        const r = await act(() => rpc<any>('ship', { p_port: b.id, p_good: good, p_qty: qty, p_to: to, p_kind: kind }), (x) => `Ship sailed: arrives in ${x.arrive_minutes} minutes. Freight ${money(x.freight)}.`);
        if (r) { reload(); refreshMe(); }
      }}>
        Ship it
      </button>
      <strong>Recent shipments</strong>
      <table className="list">
        <tbody>
          {(prop?.shipments ?? []).filter((s: any) => s.port_id === b.id).slice(0, 12).map((s: any) => (
            <tr key={s.id}>
              <td>{goodIcon(s.good_id)} {num(s.qty)} → {cityName(s.to_city)}</td>
              <td>{s.kind}</td>
              <td className="r">{s.status === 'delivered' ? (s.delivered_value ? money(s.delivered_value) : 'arrived') : `due ${new Date(s.arrive_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BankTab({ b }: { b: Business }) {
  const { data, reload } = useApi(() => rpc<any>('my_loans'), []);
  const bank = data?.banks?.find((x: any) => x.bank_id === b.id);
  const [amount, setAmount] = useState(10000000);
  const [rate, setRate] = useState<number | null>(null);
  const [maxLoan, setMaxLoan] = useState<number | null>(null);
  const [days, setDays] = useState<number | null>(null);
  if (!bank) return <Loading />;
  return (
    <div className="stack">
      <div className="grid3">
        <Stat label="Capital" value={<Money v={bank.capital} />} sub="ready to lend" />
        <Stat label="Lent out" value={<Money v={bank.lent} />} />
        <Stat label="Rate" value={`${bank.rate_daily}%/day`} />
      </div>
      <div className="card stack">
        <Field label="Move capital">
          <DollarInput value={amount} onChange={setAmount} />
        </Field>
        <div className="row">
          <button className="btn small" onClick={async () => { if (await act(() => rpc('bank_deposit', { p_bank: b.id, p_amount: amount }), 'Capital added.')) { reload(); refreshMe(); } }}>Add to bank</button>
          <button className="btn small ghost" onClick={async () => { if (await act(() => rpc('bank_withdraw', { p_bank: b.id, p_amount: amount }), 'Capital withdrawn.')) { reload(); refreshMe(); } }}>Take out</button>
        </div>
      </div>
      <div className="card stack">
        <strong>Loan terms</strong>
        <div className="grid3">
          <Field label="Daily rate %"><input className="input" type="number" step="0.05" value={rate ?? bank.rate_daily} onChange={(e) => setRate(Number(e.target.value))} /></Field>
          <Field label="Largest loan $"><input className="input" type="number" value={(maxLoan ?? bank.max_loan) / 1000} onChange={(e) => setMaxLoan(Number(e.target.value) * 1000)} /></Field>
          <Field label="Longest (days)"><input className="input" type="number" value={days ?? bank.max_days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        </div>
        <button className="btn small" onClick={async () => { if (await act(() => rpc('bank_set_terms', { p_bank: b.id, p_rate_daily: rate ?? bank.rate_daily, p_max_loan: maxLoan ?? bank.max_loan, p_max_days: days ?? bank.max_days }), 'Terms saved.')) reload(); }}>Save terms</button>
      </div>
      <strong>Loans</strong>
      {bank.loans.length === 0 ? <p className="muted small">No loans yet. Borrowers find you in Bank → Loans.</p> : (
        <table className="list">
          <thead><tr><th>Borrower</th><th className="r">Owed</th><th>Status</th></tr></thead>
          <tbody>
            {bank.loans.map((l: any) => (
              <tr key={l.id}><td>{l.borrower}</td><td className="r">{money(l.outstanding)}</td><td>{l.status}{l.missed > 0 && <span className="bad"> · behind</span>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ManageTab({ b, t, onSaved }: { b: Business; t: any; onSaved: () => void }) {
  const { set, close } = useGame.getState();
  const [name, setName] = useState(b.name);
  const [confirmSell, setConfirmSell] = useState(false);
  const sellback = Math.round(b.book_value * (catalog().config.sellback_pct ?? 50) / 100);
  return (
    <div className="stack">
      <div className="card stack">
        <Field label="Name">
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button className="btn small" disabled={name === b.name} onClick={async () => { if (await act(() => rpc('rename_business', { p_id: b.id, p_name: name }), 'Renamed.')) onSaved(); }}>Rename</button>
      </div>
      {b.upgrade_cost ? (
        <div className="card stack">
          <strong>Upgrade to level {b.level + 1}</strong>
          <p className="small muted">
            {t.placement === 'street' && `Serve ${[40, 70, 110][b.level] ?? 110} customers an hour (now ${[40, 70, 110][b.level - 1]}) and sell ${[3, 4, 6][b.level] ?? 6} dishes.`}
            {t.placement === 'room' && 'Serve 10% more customers, look more appealing, and add a menu slot.'}
            {t.placement !== 'street' && t.placement !== 'room' && 'Produce 80% more of the base rate (more crew and running costs too).'}
          </p>
          <button className="btn gold" onClick={async () => { if (await act(() => rpc('upgrade_business', { p_id: b.id }), `Upgraded to level ${b.level + 1}!`)) onSaved(); }}>
            Upgrade for {money(b.upgrade_cost)}
          </button>
        </div>
      ) : (
        <div className="card small muted">This business is at its top level.</div>
      )}
      {t.placement === 'street' && (
        <button className="btn ghost" onClick={() => { set({ mode: { kind: 'move-cart', businessId: b.id } }); close(); }}>Move this cart</button>
      )}
      <button className="btn danger" onClick={() => setConfirmSell(true)}>Sell back to the city for {money(sellback)}</button>
      {confirmSell && (
        <Confirm
          title={`Sell ${b.name}?`}
          body={<p>The city pays {money(sellback)} (half its book value). {t.placement === 'room' ? 'The lease ends.' : t.placement === 'street' ? '' : 'You keep the plot.'} This can’t be undone.</p>}
          confirm="Sell"
          danger
          onCancel={() => setConfirmSell(false)}
          onConfirm={async () => {
            if (await act(() => rpc('sell_business', { p_id: b.id }), (r: any) => `Sold for ${money(r.received)}.`)) {
              await refreshMe();
              close();
            }
          }}
        />
      )}
    </div>
  );
}

function ShopFront({ b }: { b: Business }) {
  const open = useGame((s) => s.open);
  const cat = catalog();
  const [reported, setReported] = useState(false);
  return (
    <Window title={b.name} icon={b.icon}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">{b.type_name}</span>
          <span className="chip">Level {b.level}</span>
          <span className={`chip ${b.status === 'open' ? 'green' : 'red'}`}>{b.status}</span>
        </div>
        <p>
          Run by <button className="link" onClick={() => open('profile', { player_no: b.owner_no })}>{b.owner_name}</button> (player #{b.owner_no}).
        </p>
        {b.menu && b.menu.length > 0 && (
          <div className="card">
            <strong>Menu</strong>
            <table className="list">
              <tbody>
                {b.menu.map((m) => {
                  const mi = cat.menu_items.find((x) => x.id === m.id);
                  return (
                    <tr key={m.id}>
                      <td>{mi?.icon} {mi?.name}</td>
                      <td className="r">{money(m.price)}</td>
                      <td className="r tiny muted">fair {mi && money(mi.fair_price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">Opened {ago((b as any).created_at)}. Competing nearby? Customers compare prices, so beat them on price, location or fit-out.</p>
        <button
          className="link small"
          disabled={reported}
          onClick={async () => {
            if (await act(() => rpc('report', { p_kind: 'business', p_target: b.id, p_reason: 'name' }), 'Thanks: a moderator will check this name.')) setReported(true);
          }}
        >
          {reported ? 'Reported' : 'Report this business name'}
        </button>
      </div>
    </Window>
  );
}
