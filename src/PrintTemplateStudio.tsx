import React, { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Print Template Studio — owner-facing designer for the order (KOT) + invoice
// print format. Toggles + fields + a live thermal-receipt preview. The SAME
// block spec is rendered to ESC/POS on the server (getPrintTemplate /
// render*Escpos in server.ts), so what you design here is exactly what prints.
// Config is loaded/saved via GET/PUT /api/restaurant/:id/print-templates.
// ─────────────────────────────────────────────────────────────────────────────

type DocType = 'INVOICE' | 'KOT';
type Cfg = Record<string, any>;

export const DEFAULT_INVOICE: Cfg = {
  paper: 80, logo: false, name: true, nameSize: 'big', gstin: true, address: true, phone: true,
  customer: true, mobile: true,
  date: true, cashier: true, orderType: true, billNo: true, token: true,
  colQty: true, colPrice: true, colAmount: true, notes: true,
  totalQty: true, charges: true, tax: 'split', roundOff: true, grandBig: true,
  footer: true, footerText: 'Thank you! Visit again.',
};
export const DEFAULT_KOT: Cfg = {
  paper: 80, name: true, station: true,
  orderNo: true, table: true, token: true, time: true, customer: true,
  notes: true, bigItems: true, footer: false, footerText: '',
};

const SAMPLE: Record<DocType, any> = {
  INVOICE: {
    logo: '🍜', name: 'THE HOUSE OF BOWLS', gstin: '29AARFT9486A1ZG',
    address: 'Opp. Shell Petrol Pump, Keshwapur, Hubli', phone: '0836-3595532',
    taxInvoice: true, sac: '996331',
    customer: '', mobile: '0000000000',
    date: '31/08/26', cashier: 'biller', orderType: 'Dine In: Parcel 1', billNo: '9352', token: '01',
    items: [{ name: 'Alfredo [White Sauce Pasta]', qty: 1, price: 330, amount: 330, note: '' }],
    totalQty: 1, subtotal: 330,
    charges: [{ label: 'Container Charge', amount: 13 }],
    taxSplit: [{ label: 'SGST 2.5%', amount: 8.25 }, { label: 'CGST 2.5%', amount: 8.25 }],
    taxSingle: [{ label: 'GST 5%', amount: 16.50 }],
    roundOff: 0.50, grand: 360, cur: '₹',
    footer: 'Money can buy bowls that make you Happy',
  },
  KOT: {
    logo: '🍜', name: 'THE HOUSE OF BOWLS', station: 'KITCHEN',
    orderNo: '9352', table: 'Parcel 1', token: '01', time: '8:42 PM', customer: '',
    items: [{ name: 'Alfredo [White Sauce Pasta]', qty: 1, note: 'Less spicy' },
            { name: 'Garlic Bread', qty: 2, note: '' }],
    footer: '** KITCHEN COPY **',
  },
};

type Row =
  | { sw: string; label: string; sub?: string; neu?: boolean }
  | { seg: string; label: string; opts: [string, string][] }
  | { cols: string[]; labels: string[]; label: string }
  | { text: string; label: string };
type Group = { t: string; n: number | ''; rows: Row[] };

const SCHEMA: Record<DocType, Group[]> = {
  INVOICE: [
    { t: 'Paper', n: '', rows: [{ seg: 'paper', label: 'Roll width', opts: [['58', '58 mm'], ['80', '80 mm']] }] },
    { t: 'Brand header', n: 1, rows: [
      { sw: 'logo', label: 'Logo image', sub: 'Uploads in a later update' },
      { sw: 'name', label: 'Business name' },
      { seg: 'nameSize', label: 'Name size', opts: [['normal', 'Normal'], ['big', 'Large']] },
      { sw: 'gstin', label: 'GSTIN' }, { sw: 'address', label: 'Address' }, { sw: 'phone', label: 'Phone' },
    ] },
    { t: 'Customer', n: 2, rows: [
      { sw: 'customer', label: 'Customer name line' }, { sw: 'mobile', label: 'Show mobile number' },
    ] },
    { t: 'Order meta', n: 3, rows: [
      { sw: 'date', label: 'Date' }, { sw: 'cashier', label: 'Cashier' },
      { sw: 'orderType', label: 'Order type', sub: 'Dine-in / Parcel / Delivery' },
      { sw: 'billNo', label: 'Bill number' },
      { sw: 'token', label: 'Token / Parcel #', neu: true, sub: 'Staff-entered at order time' },
    ] },
    { t: 'Items', n: 4, rows: [
      { cols: ['colQty', 'colPrice', 'colAmount'], labels: ['Qty', 'Price', 'Amount'], label: 'Columns' },
      { sw: 'notes', label: 'Show item notes / variant' },
    ] },
    { t: 'Totals & tax', n: 5, rows: [
      { sw: 'totalQty', label: 'Total quantity' },
      { sw: 'charges', label: 'Extra charges', sub: 'Container / service' },
      { seg: 'tax', label: 'Tax display', opts: [['none', 'Hide'], ['single', 'Single GST'], ['split', 'CGST + SGST']] },
      { sw: 'roundOff', label: 'Round off' }, { sw: 'grandBig', label: 'Grand total — large' },
    ] },
    { t: 'Footer', n: 6, rows: [
      { sw: 'footer', label: 'Footer message' }, { text: 'footerText', label: 'Message text' },
    ] },
  ],
  KOT: [
    { t: 'Paper', n: '', rows: [{ seg: 'paper', label: 'Roll width', opts: [['58', '58 mm'], ['80', '80 mm']] }] },
    { t: 'Header', n: 1, rows: [
      { sw: 'name', label: 'Business name' }, { sw: 'station', label: 'Station banner', sub: 'KITCHEN / BAR / TANDOOR' },
    ] },
    { t: 'Order meta', n: 2, rows: [
      { sw: 'orderNo', label: 'Order number' }, { sw: 'table', label: 'Table / parcel' },
      { sw: 'token', label: 'Token / Parcel #', neu: true, sub: 'Staff-entered at order time' },
      { sw: 'time', label: 'Time' }, { sw: 'customer', label: 'Customer name' },
    ] },
    { t: 'Items', n: 3, rows: [
      { sw: 'bigItems', label: 'Large item text', sub: 'Easier for the kitchen' },
      { sw: 'notes', label: 'Show item notes' },
    ] },
    { t: 'Footer', n: 4, rows: [
      { sw: 'footer', label: 'Footer note' }, { text: 'footerText', label: 'Note text' },
    ] },
  ],
};

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[m]);
const money = (n: any) => Number(n || 0).toFixed(2);

export function renderInvoice(c: Cfg, d: any): string {
  let H = '';
  if (c.logo) H += '<div class="pts-logo">' + d.logo + '</div>';
  if (c.name) H += '<div class="pts-c pts-b ' + (c.nameSize === 'big' ? 'pts-big' : 'pts-lg') + '">' + esc(d.name) + '</div>';
  if (c.gstin) H += '<div class="pts-c pts-muted">GSTIN : ' + esc(d.gstin) + '</div>';
  if (c.address) H += '<div class="pts-c pts-muted">' + esc(d.address) + '</div>';
  if (c.phone) H += '<div class="pts-c pts-muted">Ph: ' + esc(d.phone) + '</div>';
  // GST compliance: a registered supplier's bill is a TAX INVOICE — an auto legal
  // label, never an owner toggle.
  if (d.taxInvoice) H += '<div class="pts-c pts-b" style="letter-spacing:1px;margin-top:2px">TAX INVOICE</div>';
  if (c.logo || c.name || c.gstin || c.address || c.phone || d.taxInvoice) H += '<hr class="pts-hr">';
  if (c.customer && (d.customer || d.mobile)) {
    let nm = 'Name: ' + esc(d.customer || ''); if (c.mobile && d.mobile) nm += '  (M: ' + esc(d.mobile) + ')';
    H += '<div>' + nm + '</div><hr class="pts-hr">';
  }
  let meta = '';
  if (c.date || c.orderType) meta += rrow(c.date ? 'Date: ' + d.date : '', c.orderType ? d.orderType : '', true);
  if (c.cashier || c.billNo) meta += rrow(c.cashier ? 'Cashier: ' + d.cashier : '', c.billNo ? 'Bill No.: ' + d.billNo : '', false);
  if (c.token) meta += '<div class="pts-rrow pts-b"><span>Token: ' + esc(d.token) + '</span><span></span></div>';
  if (meta) H += meta + '<hr class="pts-hr">';
  const gt = '1fr' + (c.colQty ? ' 30px' : '') + (c.colPrice ? ' 52px' : '') + (c.colAmount ? ' 58px' : '');
  H += '<div class="pts-items-h" style="grid-template-columns:' + gt + '"><span>Item</span>' +
    (c.colQty ? '<span class="pts-r">Qty</span>' : '') + (c.colPrice ? '<span class="pts-r">Price</span>' : '') + (c.colAmount ? '<span class="pts-r">Amt</span>' : '') + '</div>';
  (d.items || []).forEach((it: any) => {
    H += '<div class="pts-item" style="grid-template-columns:' + gt + '"><span class="pts-nm">' + esc(it.name) + '</span>' +
      (c.colQty ? '<span class="pts-r">' + it.qty + '</span>' : '') +
      (c.colPrice ? '<span class="pts-r">' + money(it.price) + '</span>' : '') +
      (c.colAmount ? '<span class="pts-r">' + money(it.amount) + '</span>' : '') +
      (c.notes && it.note ? '<span class="pts-note">&raquo; ' + esc(it.note) + '</span>' : '') + '</div>';
  });
  H += '<hr class="pts-hr">';
  // GST compliance (auto for a tax invoice): SAC + reverse-charge, and the
  // subtotal reads "Taxable value" as a tax invoice requires.
  if (d.taxInvoice) {
    H += '<div class="pts-muted">SAC: ' + esc(d.sac || '996331') + ' &middot; Restaurant service</div>';
    H += '<div class="pts-muted">Reverse charge: No</div>';
  }
  const subLbl = d.taxInvoice ? 'Taxable value' : 'Sub Total';
  if (c.totalQty) H += '<div class="pts-rrow"><span class="pts-muted">Total Qty: ' + d.totalQty + '</span><span class="pts-b">' + subLbl + ' ' + money(d.subtotal) + '</span></div>';
  else H += trow(subLbl, money(d.subtotal));
  if (Number(d.discount)) H += trow(esc(d.discountLabel || 'Discount'), '-' + money(d.discount));
  if (c.charges) (d.charges || []).forEach((x: any) => { H += trow(esc(x.label), money(x.amount)); });
  if (c.tax === 'split') (d.taxSplit || []).forEach((x: any) => { H += trow(x.label, money(x.amount)); });
  else if (c.tax === 'single') (d.taxSingle || []).forEach((x: any) => { H += trow(x.label, money(x.amount)); });
  if (c.roundOff) H += trow('Round off', '+' + money(d.roundOff));
  H += '<hr class="pts-hr"><div class="pts-rrow pts-b ' + (c.grandBig ? 'pts-big' : '') + '"><span>' + (c.grandBig ? 'GRAND TOTAL' : 'Grand Total') + '</span><span>' + d.cur + ' ' + money(d.grand) + '</span></div><hr class="pts-hr">';
  if (d.payment_method) H += '<div class="pts-c">Paid via <b>' + esc(d.payment_method) + '</b></div>';
  if (c.footer) H += '<div class="pts-c pts-b">' + esc(c.footerText || d.footer) + '</div>';
  return H;
}
export function renderKot(c: Cfg, d: any): string {
  let H = '<div class="pts-c pts-b pts-big">KOT</div>';
  if (c.station) H += '<div class="pts-c pts-b">' + esc(d.station) + '</div>';
  if (c.name) H += '<div class="pts-c pts-muted">' + esc(d.name) + '</div>';
  H += '<hr class="pts-hr">';
  if (c.orderNo) H += '<div>Order: ' + esc(d.orderNo) + '</div>';
  const l2: string[] = []; if (c.table) l2.push('Table: ' + d.table); if (c.time) l2.push(d.time);
  if (l2.length) H += '<div class="pts-rrow"><span>' + esc(l2[0]) + '</span><span>' + esc(l2[1] || '') + '</span></div>';
  if (c.token) H += '<div class="pts-b pts-lg">Token: ' + esc(d.token) + '</div>';
  if (c.customer && d.customer) H += '<div>Guest: ' + esc(d.customer) + '</div>';
  H += '<hr class="pts-hr">';
  (d.items || []).forEach((it: any) => {
    H += '<div class="pts-kot-item' + (c.bigItems ? ' pts-lg' : '') + '"><span class="pts-q">' + it.qty + ' x</span><span>' + esc(it.name) +
      (c.notes && it.note ? '<div class="pts-note" style="font-weight:400">&raquo; ' + esc(it.note) + '</div>' : '') + '</span></div>';
  });
  H += '<hr class="pts-hr">';
  if (c.footer) H += '<div class="pts-c pts-b">' + esc(c.footerText || d.footer) + '</div>';
  return H;
}
const rrow = (l: string, r: string, b: boolean) => '<div class="pts-rrow' + (b ? ' pts-b' : '') + '"><span>' + esc(l) + '</span><span>' + esc(r) + '</span></div>';
const trow = (l: string, v: string) => '<div class="pts-rrow"><span>' + esc(l) + '</span><span>' + v + '</span></div>';

export function PrintTemplateStudio({ restaurantId, token }: { restaurantId: string; token: string }) {
  const [docType, setDocType] = useState<DocType>('INVOICE');
  const [cfg, setCfg] = useState<Record<DocType, Cfg>>({ INVOICE: DEFAULT_INVOICE, KOT: DEFAULT_KOT });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [restaurantId]);
  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/restaurant/${restaurantId}/print-templates`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        setCfg({ INVOICE: { ...DEFAULT_INVOICE, ...(d.INVOICE || {}) }, KOT: { ...DEFAULT_KOT, ...(d.KOT || {}) } });
      }
    } catch { /* keep defaults */ } finally { setLoading(false); }
  }
  async function save() {
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/api/restaurant/${restaurantId}/print-templates/${docType}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ config: cfg[docType] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.error || 'Save failed'); } else { setSaved(true); setTimeout(() => setSaved(false), 2500); }
    } catch (e: any) { setErr(e?.message || 'Save failed'); } finally { setSaving(false); }
  }
  const setKey = (k: string, v: any) => { setCfg((c) => ({ ...c, [docType]: { ...c[docType], [k]: v } })); setSaved(false); };
  const resetDefaults = () => { setCfg((c) => ({ ...c, [docType]: docType === 'KOT' ? { ...DEFAULT_KOT } : { ...DEFAULT_INVOICE } })); setSaved(false); };

  const c = cfg[docType];
  const previewHtml = docType === 'INVOICE' ? renderInvoice(c, SAMPLE.INVOICE) : renderKot(c, SAMPLE.KOT);
  const W = c.paper == 58 ? 210 : 300;
  const tab = (d: DocType, label: string) => (
    <button onClick={() => { setDocType(d); setSaved(false); }}
      className={'px-4 py-2 rounded-lg text-sm font-bold transition ' + (docType === d ? 'bg-[#cc5a16] text-white shadow' : 'text-[#7c7267] hover:text-[#241d14]')}>{label}</button>
  );

  return (
    <div className="max-w-6xl mx-auto p-2">
      <style>{PTS_CSS}</style>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-[#241d14]">Print Template Studio</h2>
          <p className="text-sm text-[#7c7267] mt-1 max-w-xl">Design your own <b>order (KOT)</b> and <b>invoice</b> print. Toggle what shows, edit the text, watch it live — the same layout is what prints.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex bg-[#faf7f2] border border-[#e7e0d5] rounded-xl p-1 gap-1">{tab('INVOICE', 'Invoice')}{tab('KOT', 'Order (KOT)')}</div>
          <button onClick={resetDefaults} className="px-3 py-2 rounded-lg border border-[#e7e0d5] text-sm font-semibold text-[#7c7267] hover:bg-[#faf7f2]">Reset</button>
          <button onClick={save} disabled={saving}
            className="px-5 py-2 rounded-lg bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] disabled:opacity-60">
            {saving ? 'Saving…' : saved ? 'Saved ✓' : `Save ${docType === 'KOT' ? 'KOT' : 'Invoice'}`}
          </button>
        </div>
      </div>
      {err && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

      <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(300px,380px) 1fr' }}>
        <div className="flex flex-col gap-3">
          {loading ? <div className="text-sm text-[#7c7267] p-4">Loading…</div> :
            SCHEMA[docType].map((g, gi) => (
              <div key={gi} className="bg-white border border-[#e7e0d5] rounded-2xl overflow-hidden">
                <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-[#7c7267] px-4 py-3 border-b border-[#efe9df] bg-[#faf7f2] flex items-center gap-2">
                  {g.n !== '' && <span className="w-5 h-5 rounded-md bg-[#cc5a16]/10 text-[#cc5a16] grid place-items-center text-[11px] font-extrabold">{g.n}</span>}{g.t}
                </h3>
                <div className="px-4 py-2">{g.rows.map((row, ri) => <React.Fragment key={ri}><ControlRow row={row} c={c} setKey={setKey} /></React.Fragment>)}</div>
              </div>
            ))}
        </div>

        <div className="sticky top-4 self-start">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-wider text-[#7c7267] font-extrabold">Live preview</span>
            <span className="text-xs font-bold text-[#7c7267] bg-[#f0eadf] border border-[#e7e0d5] px-2.5 py-1 rounded-full">{c.paper == 58 ? '58' : '80'} mm roll</span>
          </div>
          <div className="pts-stage">
            <div className="pts-receipt" style={{ width: W }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
          <div className="text-xs text-[#7c7267] mt-3 flex gap-2">
            <span>💡</span><span><b className="text-[#241d14]">This is the real layout engine.</b> The same spec renders this preview and the thermal print, so what you save is what prints. Changes apply once your site's print agent is on v3.2+.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlRow({ row, c, setKey }: { row: Row; c: Cfg; setKey: (k: string, v: any) => void }) {
  if ('sw' in row) {
    return (
      <div className="flex items-center justify-between gap-3 py-2 min-h-[34px] border-b border-[#efe9df] last:border-0">
        <label className="text-[13.5px] font-semibold flex-1 flex flex-col">
          <span className="flex items-center gap-2">{row.label}{row.neu && <span className="text-[9.5px] font-extrabold tracking-wide text-[#cc5a16] bg-[#cc5a16]/10 px-1.5 py-0.5 rounded-full uppercase">new</span>}</span>
          {row.sub && <small className="font-normal text-[#7c7267] text-[11.5px]">{row.sub}</small>}
        </label>
        <Switch on={!!c[row.sw]} onChange={(v) => setKey(row.sw, v)} />
      </div>
    );
  }
  if ('seg' in row) {
    return (
      <div className="flex flex-col gap-1.5 py-2 border-b border-[#efe9df] last:border-0">
        <label className="text-xs font-bold text-[#7c7267]">{row.label}</label>
        <div className="inline-flex gap-1 flex-wrap">
          {row.opts.map(([v, lbl]) => (
            <button key={v} onClick={() => setKey(row.seg, isNaN(Number(v)) ? v : Number(v))}
              className={'text-xs font-bold px-2.5 py-1.5 rounded-lg border ' + (String(c[row.seg]) === v ? 'border-[#cc5a16] bg-[#cc5a16]/10 text-[#cc5a16]' : 'border-[#e7e0d5] bg-[#faf7f2] text-[#7c7267]')}>{lbl}</button>
          ))}
        </div>
      </div>
    );
  }
  if ('cols' in row) {
    return (
      <div className="flex flex-col gap-1.5 py-2 border-b border-[#efe9df] last:border-0">
        <label className="text-xs font-bold text-[#7c7267]">{row.label}</label>
        <div className="flex gap-1.5 flex-wrap">
          <span className="text-xs font-semibold border border-[#e7e0d5] bg-[#faf7f2] px-2.5 py-1.5 rounded-lg opacity-60">Item ✓</span>
          {row.cols.map((k, i) => (
            <button key={k} onClick={() => setKey(k, !c[k])}
              className={'text-xs font-semibold px-2.5 py-1.5 rounded-lg border ' + (c[k] ? 'border-[#cc5a16] bg-[#cc5a16]/10 text-[#cc5a16]' : 'border-[#e7e0d5] bg-[#faf7f2] text-[#7c7267]')}>{row.labels[i]}</button>
          ))}
        </div>
      </div>
    );
  }
  // text
  return (
    <div className="flex flex-col gap-1.5 py-2 border-b border-[#efe9df] last:border-0">
      <label className="text-xs font-bold text-[#7c7267]">{row.label}</label>
      <input type="text" value={c[row.text] || ''} onChange={(e) => setKey(row.text, e.target.value)}
        className="text-[13.5px] bg-[#faf7f2] border border-[#e7e0d5] rounded-lg px-2.5 py-2 outline-none focus:border-[#cc5a16]" />
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} aria-pressed={on}
      className={'relative w-10 h-[23px] rounded-full transition ' + (on ? 'bg-[#cc5a16]' : 'bg-[#e7e0d5]')}>
      <span className={'absolute top-[2px] w-[19px] h-[19px] rounded-full bg-white shadow transition-all ' + (on ? 'left-[19px]' : 'left-[2px]')} />
    </button>
  );
}

export const PTS_CSS = `
.pts-stage{background:repeating-linear-gradient(45deg,transparent,transparent 11px,rgba(124,114,103,.06) 11px,rgba(124,114,103,.06) 12px),#faf7f2;border:1px solid #e7e0d5;border-radius:16px;padding:26px 10px;display:flex;justify-content:center;min-height:360px}
.pts-receipt{background:#fcfbf6;color:#1a1610;box-shadow:0 1px 2px rgba(40,30,15,.05),0 8px 30px rgba(40,30,15,.08);font-family:"Courier New",ui-monospace,monospace;font-size:12.5px;line-height:1.5;padding:16px 14px 14px}
.pts-c{text-align:center}.pts-r{text-align:right}.pts-b{font-weight:700}
.pts-big{font-size:16px;font-weight:800}.pts-lg{font-size:14.5px}
.pts-logo{font-size:34px;line-height:1;margin:2px 0 6px;text-align:center;filter:grayscale(1) contrast(1.1)}
.pts-hr{border:0;border-top:1px dashed #c9c2b4;margin:7px 0}
.pts-muted{opacity:.8}
.pts-rrow{display:flex;justify-content:space-between;gap:10px}
.pts-items-h,.pts-item{display:grid;gap:6px;align-items:start}
.pts-items-h{font-weight:700;padding-bottom:2px}
.pts-item .pts-nm{overflow-wrap:anywhere}
.pts-item .pts-note{grid-column:1/-1;padding-left:8px;font-size:11.5px;opacity:.8}
.pts-kot-item{display:flex;gap:8px;padding:2px 0;font-weight:700}
.pts-kot-item .pts-q{min-width:26px}
`;

export default PrintTemplateStudio;
