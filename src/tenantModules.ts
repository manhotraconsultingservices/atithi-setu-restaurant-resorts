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
