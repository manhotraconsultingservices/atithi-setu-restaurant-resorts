// Subscription list prices per tier (GET/POST /api/admin/subscription-prices,
// Super Admin and CTO). Shown to owners on their Subscription tab.
import React, { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';

const TIERS: { tier: string; plans: string; key: '' | '_hotel' | '_combined' }[] = [
  { tier: 'Restaurant', plans: 'Starter / Professional / Multi-outlet', key: '' },
  { tier: 'Hotel', plans: 'Boutique / Resort / Chain', key: '_hotel' },
  { tier: 'Hotel + Restaurant', plans: 'Both sides together', key: '_combined' },
];

export function SubscriptionPrices({ token }: { token: string }) {
  const toast = useToast();
  const [prices, setPrices] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch('/api/admin/subscription-prices', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)).then(d => setPrices(d || {})).catch(() => setPrices({}));
  }, [token]);
  const save = async () => {
    if (!prices) return;
    setSaving(true);
    try {
      const r = await fetch('/api/admin/subscription-prices', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(prices) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `Save failed (${r.status})`);
      toast.success('Prices saved.');
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };
  return (
    <div className="space-y-4 text-slate-900">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">Subscription prices</h2>
        <p className="text-[13px] text-slate-500">List prices per tier, shown to owners on their Subscription tab. A change applies to new renewals.</p>
      </div>
      {!prices ? <div className="text-sm text-slate-400">Loading…</div> : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
          {TIERS.map(({ tier, plans, key }) => (
            <div key={tier} className="grid grid-cols-1 sm:grid-cols-[1fr_160px_160px] gap-3 items-end px-4 py-3">
              <div><div className="text-[13.5px] font-medium">{tier}</div><div className="text-[12px] text-slate-500">{plans}</div></div>
              {(['monthly', 'annual'] as const).map(p => (
                <label key={p} className="flex flex-col gap-1 text-[12px] text-slate-500">{p === 'monthly' ? 'Monthly (₹)' : 'Annual (₹)'}
                  <input id={`price-${p}${key || '_restaurant'}`} type="number" min={0} value={prices[`${p}_price${key}`] ?? ''}
                    onChange={e => setPrices({ ...prices, [`${p}_price${key}`]: e.target.value })}
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] font-mono text-right outline-none focus:border-brand" />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      <button type="button" onClick={save} disabled={saving || !prices} className="h-9 px-4 rounded-lg bg-brand text-white text-[13px] font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Save prices'}</button>
    </div>
  );
}
