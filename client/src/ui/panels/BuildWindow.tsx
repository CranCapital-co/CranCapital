import { rpc } from '../../lib/supabase';
import { useGame, act, catalog, goodName } from '../../lib/store';
import { money } from '../../lib/format';
import { Window, useApi } from '../components';
import { refreshMe } from '../common';
import type { Business } from '../../lib/types';
import { BizIcon, Icon } from '../Icon';

export default function BuildWindow() {
  const me = useGame((s) => s.me)!;
  const { set, close, open, toast } = useGame.getState();
  const cat = catalog();
  const { data: mine } = useApi(() => rpc<Business[]>('my_businesses'), []);
  const carts = (mine ?? []).filter((b) => b.kind === 'cart' && (b.status === 'open' || b.status === 'closed')).length;
  const types = (tier: number) => cat.business_types.filter((t) => t.tier === tier);
  const locked = (tier: number) => me.tier < tier;
  const tierInfo = (tier: number) => cat.tiers.find((t) => t.tier === tier)!;

  const Section = ({ tier, children }: { tier: number; children: React.ReactNode }) => (
    <section className={`card stack ${locked(tier) ? 'locked' : ''}`} style={locked(tier) ? { opacity: 0.6 } : undefined}>
      <div className="row between">
        <strong>Tier {tier}: {tierInfo(tier).name}</strong>
        {locked(tier) ? <span className="chip"><Icon name="lock" size={14} /> {money(tierInfo(tier).net_worth, { compact: true })} net worth</span> : <span className="chip green">Unlocked</span>}
      </div>
      <div className="small muted">New idea: {tierInfo(tier).idea}.</div>
      {children}
    </section>
  );

  return (
    <Window title="Build" icon="build">
      <div className="stack">
        <Section tier={1}>
          <div className="row between">
            <div>
              <b className="row" style={{ display: 'inline-flex', gap: 6 }}><BizIcon kind="cart" tier={1} size={44} /> Food cart</b> · {money(types(1)[0].cost)}
              <div className="small muted">{carts} of {cat.config.max_carts} carts. Busy streets near stations and sights sell most: the foot traffic button in the map tools shows where crowds are thickest.</div>
            </div>
            <button
              className="btn small"
              disabled={carts >= (cat.config.max_carts ?? 5)}
              onClick={() => {
                set({ mode: { kind: 'place-cart' } });
                close();
              }}
            >
              Choose a spot
            </button>
          </div>
        </Section>

        <Section tier={2}>
          <p className="small">Tap any building on the map to see its rooms, then rent one and open a business there. You’ll fit it out, hire staff and set hours.</p>
          <table className="list">
            <tbody>
              {types(2).map((t) => (
                <tr key={t.id}>
                  <td className="nowrap"><BizIcon kind={t.id} tier={t.tier} size={40} /> {t.name}</td>
                  <td className="small muted">{t.description}</td>
                  <td className="r nowrap">{money(t.cost, { cents: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section tier={3}>
          <p className="small">Turn on land mode (map tools, then Land), tap a green plot and buy it, then build on it. You can also buy whole buildings by tapping them, and earn rent.</p>
          <table className="list">
            <tbody>
              {types(3).map((t) => (
                <tr key={t.id}><td className="nowrap"><BizIcon kind={t.id} tier={t.tier} size={40} /> {t.name}</td><td className="small muted">{t.description}</td><td className="r nowrap">{money(t.cost, { cents: false })}</td></tr>
              ))}
            </tbody>
          </table>
          <button className="btn small ghost" disabled={locked(3)} onClick={() => { set({ mode: { kind: 'land' } }); close(); }}>Show plots</button>
        </Section>

        <Section tier={4}>
          <p className="small">
            A survey ({money(cat.config.survey_cost)}) reveals what’s buried in the 200 m block you’re standing in. Only you see the results.
            Then buy the plot with the deposit and build a mine on it.
          </p>
          <table className="list">
            <tbody>
              {types(4).map((t) => (
                <tr key={t.id}><td className="nowrap"><BizIcon kind={t.id} tier={t.tier} size={40} /> {t.name}</td><td className="small muted">{goodName(t.resource!)}: {t.rate_per_hour}/h</td><td className="r nowrap">{money(t.cost, { cents: false })}</td></tr>
              ))}
            </tbody>
          </table>
          <button
            className="btn small"
            disabled={locked(4)}
            onClick={() => {
              // No character: pick the block to survey on the map.
              set({ mode: { kind: 'survey' } });
              close();
              toast('Tap a block on the map to survey it for minerals.', 'info');
            }}
          >
            Survey where I’m standing
          </button>
        </Section>

        <Section tier={5}>
          <p className="small">Factories go on plots you own. Ports need a plot right by open water (shown in blue in land mode).</p>
          <table className="list">
            <tbody>
              {types(5).map((t) => {
                const r = t.recipe ? cat.recipes.find((x) => x.id === t.recipe) : null;
                return (
                  <tr key={t.id}>
                    <td className="nowrap"><BizIcon kind={t.id} tier={t.tier} size={40} /> {t.name}</td>
                    <td className="small muted">{r ? `${Object.keys(r.inputs).map(goodName).join(' + ')} → ${Object.keys(r.outputs).map(goodName).join(' + ')}` : t.description}</td>
                    <td className="r nowrap">{money(t.cost, { compact: true })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        <Section tier={6}>
          <p className="small">Open a bank in a rented room and lend your capital at the rate you choose, or take your company public from the Bank window.</p>
          <button className="btn small ghost" onClick={() => open('bank', { tab: 'shares' })}>Shares and IPOs</button>
        </Section>
      </div>
    </Window>
  );
}
