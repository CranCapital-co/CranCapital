import { useState } from 'react';
import { rpc } from '../../lib/supabase';
import { useGame, act } from '../../lib/store';
import { money, ago, date, num } from '../../lib/format';
import { Window, Tabs, useApi, Loading, Money, Stat, Field, DollarInput, Empty } from '../components';
import { refreshMe } from '../common';

type Tab = 'balance' | 'loans' | 'shares';

export default function BankWindow({ params }: { params?: { tab?: Tab } }) {
  const [tab, setTab] = useState<Tab>(params?.tab ?? 'balance');
  return (
    <Window title="Bank" icon="🏦">
      <div className="stack">
        <Tabs tabs={[['balance', 'Balance'], ['loans', 'Loans'], ['shares', 'Shares']]} value={tab} onChange={setTab} />
        {tab === 'balance' && <Balance />}
        {tab === 'loans' && <Loans />}
        {tab === 'shares' && <Shares />}
      </div>
    </Window>
  );
}

function Balance() {
  const me = useGame((s) => s.me)!;
  const [kind, setKind] = useState<string>('');
  const [rows, setRows] = useState<any[] | null>(null);
  const { data } = useApi(async () => {
    const r = await rpc<any>('my_ledger', { p_kind: kind || null });
    setRows(r.rows);
    return r;
  }, [kind]);
  const more = async () => {
    if (!rows?.length) return;
    const r = await rpc<any>('my_ledger', { p_kind: kind || null, p_before: rows[rows.length - 1].id });
    setRows([...rows, ...r.rows]);
  };
  const kinds = Array.from(new Set((data?.today ?? []).map((t: any) => t.kind)));
  return (
    <div className="stack">
      <div className="grid2">
        <Stat label="Cash" value={<Money v={me.cash} />} />
        <Stat label="Net worth" value={<Money v={me.net_worth} />} sub="cash, businesses, property, goods, minus debts" />
      </div>
      <div className="card">
        <strong className="small">Last 24 hours</strong>
        {!data ? <Loading /> : (
          <table className="list">
            <tbody>
              {data.today.map((t: any) => (
                <tr key={t.kind}><td>{t.label}</td><td className="r"><Money v={t.amount} sign /></td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="row between">
        <strong>Every transaction</strong>
        <select className="input" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k as string} value={k as string}>{data.today.find((t: any) => t.kind === k)?.label}</option>)}
        </select>
      </div>
      {!rows ? <Loading /> : (
        <table className="list">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="small">{r.memo ?? r.label}{r.hourly && r.entries > 1 && <span className="muted"> · {r.entries} entries this hour</span>}</div>
                  <div className="tiny muted">{ago(r.at)}</div>
                </td>
                <td className="r"><Money v={r.amount} sign /><div className="tiny muted">{money(r.balance_after)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length >= 50 && <button className="btn ghost small" onClick={more}>Load more</button>}
      <p className="tiny muted">Every dollar that moves in CranCapital is recorded here. Automatic income and costs are summed by the hour.</p>
    </div>
  );
}

function Loans() {
  const { data: banks, reload } = useApi(() => rpc<any>('list_banks'), []);
  const { data: mine, reload: reloadMine } = useApi(() => rpc<any>('my_loans'), []);
  const [amount, setAmount] = useState(1000000);
  const [days, setDays] = useState(7);
  const [bank, setBank] = useState<number | null>(null);
  if (!banks || !mine) return <Loading />;
  const chosen = bank ? banks.banks.find((b: any) => b.bank_id === bank) : null;
  const rate = chosen ? chosen.rate_daily : banks.city.rate_daily;
  const interest = Math.round((amount * rate * days) / 100 / 2);
  return (
    <div className="stack">
      <div className="grid2">
        <Stat label="You can borrow" value={<Money v={Math.max(0, banks.credit_limit - banks.debt)} />} sub="30% of net worth, minus debts" />
        <Stat label="You owe" value={<Money v={banks.debt} />} />
      </div>
      {banks.blocked_until && new Date(banks.blocked_until) > new Date() && <div className="notice red small">You defaulted recently. You can borrow again from {date(banks.blocked_until)}.</div>}
      <div className="card stack">
        <strong>Borrow</strong>
        <Field label="Lender">
          <select className="input" value={bank ?? ''} onChange={(e) => setBank(e.target.value ? Number(e.target.value) : null)}>
            <option value="">City bank · {banks.city.rate_daily}% a day · up to 30 days</option>
            {banks.banks.filter((b: any) => !b.mine).map((b: any) => (
              <option key={b.bank_id} value={b.bank_id}>{b.name} ({b.owner_name}) · {b.rate_daily}% a day · up to {money(b.max_loan, { compact: true })}, {b.max_days} days</option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Amount"><DollarInput value={amount} onChange={setAmount} /></Field>
          <Field label="Days"><input className="input" type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        </div>
        <p className="small muted">Repaid automatically every minute: interest plus an even share of the loan. Expect roughly {money(interest)} interest in total. Miss repayments for 7 days and the loan defaults.</p>
        <button className="btn" onClick={async () => { if (await act(() => rpc('take_loan', { p_bank: bank, p_amount: amount, p_days: days }), 'Loan paid into your account.')) { reload(); reloadMine(); refreshMe(); } }}>
          Borrow {money(amount)}
        </button>
      </div>
      <strong>Your loans</strong>
      {mine.borrowed.length === 0 ? <p className="small muted">No loans.</p> : (
        <table className="list">
          <tbody>
            {mine.borrowed.map((l: any) => (
              <tr key={l.id}>
                <td><div className="small">{l.lender}</div><div className="tiny muted">{l.rate_daily}% a day · {l.status}{l.missed > 0 ? ' · behind on repayments' : ''}</div></td>
                <td className="r num">{money(l.outstanding)}</td>
                <td className="r">{l.status === 'active' && <button className="btn tiny" onClick={async () => { if (await act(() => rpc('repay_loan', { p_loan: l.id }), 'Loan repaid.')) { reload(); reloadMine(); refreshMe(); } }}>Repay</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mine.banks.length > 0 && <p className="small muted">You run {mine.banks.length} bank{mine.banks.length > 1 ? 's' : ''}: manage lending from the bank’s own window.</p>}
    </div>
  );
}

function Shares() {
  const me = useGame((s) => s.me)!;
  const { data, reload } = useApi(() => rpc<any>('share_market'), []);
  const [sym, setSym] = useState<string | null>(null);
  const [qty, setQty] = useState(100);
  const [price, setPrice] = useState(0);
  const [ipoName, setIpoName] = useState(`${me.display_name} Holdings`);
  const [ipoPrice, setIpoPrice] = useState(5000);
  const [ipoShares, setIpoShares] = useState(100000);
  const [div, setDiv] = useState(100);
  if (!data) return <Loading />;
  const mineCo = data.companies.find((c: any) => c.owner_no === me.player_no);
  const sel = data.companies.find((c: any) => c.symbol === sym);
  return (
    <div className="stack">
      {data.companies.length === 0 ? <Empty icon="🔔" title="No public companies yet">Tier-6 players can take their company public here.</Empty> : (
        <table className="list">
          <thead><tr><th>Company</th><th className="r">Price</th><th className="r">You hold</th></tr></thead>
          <tbody>
            {data.companies.map((c: any) => (
              <tr key={c.symbol} className="click" onClick={() => { setSym(c.symbol); setPrice(c.best_ask ?? c.last_price); }}>
                <td><b>{c.symbol}</b> <span className="small">{c.name}</span><div className="tiny muted">{c.owner_name} · dividends paid {money(c.dividends_paid, { compact: true })}</div></td>
                <td className="r num">{money(c.last_price)}</td>
                <td className="r num">{num(c.my_shares ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sel && (
        <div className="card stack">
          <strong>Trade {sel.symbol}</strong>
          <div className="small muted">Best buyer {money(sel.best_bid)} · best seller {money(sel.best_ask)} · owner’s net worth {money(sel.owner_net_worth, { compact: true })}</div>
          <div className="grid2">
            <Field label="Shares"><input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></Field>
            <Field label="Price each"><DollarInput value={price} onChange={setPrice} /></Field>
          </div>
          <div className="row">
            <button className="btn small" onClick={async () => { if (await act(() => rpc('place_share_order', { p_symbol: sel.symbol, p_side: 'buy', p_qty: qty, p_price: price }), 'Order placed.')) { reload(); refreshMe(); } }}>Buy</button>
            <button className="btn small gold" onClick={async () => { if (await act(() => rpc('place_share_order', { p_symbol: sel.symbol, p_side: 'sell', p_qty: qty, p_price: price }), 'Order placed.')) { reload(); refreshMe(); } }}>Sell</button>
          </div>
        </div>
      )}
      {data.my_orders.length > 0 && (
        <div className="card">
          <strong className="small">Your share orders</strong>
          <table className="list"><tbody>
            {data.my_orders.map((o: any) => (
              <tr key={o.id}><td>{o.symbol} {o.side}</td><td className="r num">{num(o.qty - o.filled)} @ {money(o.price)}</td>
                <td className="r"><button className="btn tiny ghost" onClick={async () => { if (await act(() => rpc('cancel_share_order', { p_order: o.id }), 'Cancelled.')) { reload(); refreshMe(); } }}>Cancel</button></td></tr>
            ))}
          </tbody></table>
        </div>
      )}
      {mineCo ? (
        <div className="card stack">
          <strong>Your company: {mineCo.symbol}</strong>
          <Field label="Dividend per share"><DollarInput value={div} onChange={setDiv} /></Field>
          <button className="btn small" onClick={async () => { if (await act(() => rpc<any>('pay_dividend', { p_per_share: div }), (r) => `Paid ${money(r.paid)} in dividends.`)) { reload(); refreshMe(); } }}>Pay dividend</button>
        </div>
      ) : (
        <div className="card stack">
          <strong>Take your company public</strong>
          {me.tier < 6 ? <p className="small muted">Unlocks at tier 6 (Finance).</p> : (
            <>
              <p className="small muted">Sell up to 49% of your 1,000,000 shares. Buyers can trade them and receive the dividends you declare.</p>
              <Field label="Company name"><input className="input" value={ipoName} maxLength={40} onChange={(e) => setIpoName(e.target.value)} /></Field>
              <div className="grid2">
                <Field label="Price per share"><DollarInput value={ipoPrice} onChange={setIpoPrice} /></Field>
                <Field label="Shares to offer"><input className="input" type="number" value={ipoShares} onChange={(e) => setIpoShares(Number(e.target.value))} /></Field>
              </div>
              <button className="btn gold" onClick={async () => { if (await act(() => rpc('ipo', { p_name: ipoName, p_price: ipoPrice, p_shares: ipoShares }), 'You’re public! Your shares are on the market.')) reload(); }}>Go public</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
