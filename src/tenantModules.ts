// Paid modules the platform switched on for this property (Online Payments,
// WhatsApp). App.tsx mirrors them here whenever the property record loads, so
// detached module views (Events, Spa, payment dialogs) can grey out controls
// without prop-drilling — the same pattern as perm.ts. The server enforces the
// same switches; this only keeps staff from pressing a button that will refuse.

export type PaidModule = 'online_payments' | 'whatsapp' | 'accounts' | 'people';

const KEY = 'tenant_modules';

export function setTenantModules(restaurant: any): void {
  if (!restaurant) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      online_payments: Number(restaurant.online_payments_enabled) === 1,
      whatsapp: Number(restaurant.whatsapp_enabled) === 1,
      accounts: Number(restaurant.accounts_enabled) === 1,
      people: Number(restaurant.people_enabled) === 1,
      // Business modules, for filters and pickers that should only offer what
      // the property runs.
      hotel: ['HOTEL', 'BOTH'].includes(String(restaurant.property_type || 'RESTAURANT').toUpperCase()),
      restaurant: ['RESTAURANT', 'BOTH'].includes(String(restaurant.property_type || 'RESTAURANT').toUpperCase()),
      spa: Number(restaurant.spa_enabled) === 1,
      events: Number(restaurant.events_enabled) === 1,
    }));
  } catch { /* storage blocked: controls stay greyed, the server still decides */ }
}

// True only when the property record said the module is off. Screens that may
// render before the record loads (chef, waiter) hide on this, not on !moduleOn.
export function moduleOff(m: PaidModule): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v[m] === false;
  } catch { return false; }
}

export function moduleOn(m: PaidModule): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v[m] === true;
  } catch { return false; }
}

// The cost/expense modules this property runs: RESTAURANT, HOTEL, EVENTS, SPA,
// plus SHARED when there is more than one to share between. Null when the
// property record has not been seen yet — callers then show everything rather
// than hide a module the property does run.
export function businessModules(): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (typeof v.hotel !== 'boolean') return null;
    const out: string[] = [];
    if (v.restaurant) out.push('RESTAURANT');
    if (v.hotel) out.push('HOTEL');
    if (v.events) out.push('EVENTS');
    if (v.spa) out.push('SPA');
    if (out.length > 1) out.push('SHARED');
    return out;
  } catch { return null; }
}
