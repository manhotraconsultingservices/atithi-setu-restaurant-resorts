// Shared frontend permission gate — mirrors the backend requireTabAction levels
// (View=1, Edit=2, Full=3). Reads the `tab_perms` map App.tsx mirrors into
// localStorage on login, so it works in BOTH the main App render and the many
// standalone view components (LoyaltyManagement, BookingsManagement, …) where the
// App-scoped `canDo` isn't available. The BACKEND is the security boundary — this
// only hides controls a role can't use, so a View-only user isn't led into an
// action the server will reject.
export function tabLevel(tab: string): number {
  try {
    const role = (localStorage.getItem('role') || '').toUpperCase();
    if (role === 'OWNER' || role === 'SUPER_ADMIN' || role === 'CTO') return 3;
    const perms = JSON.parse(localStorage.getItem('tab_perms') || '{}');
    if (!perms || Object.keys(perms).length === 0) return 3; // no restrictions configured → don't hide
    return Number(perms[tab] || 0);
  } catch { return 3; } // fail-open (backend still enforces) — never hide controls on a storage glitch
}
export const canWriteTab = (tab: string): boolean => tabLevel(tab) >= 2;  // create / update
export const canDeleteTab = (tab: string): boolean => tabLevel(tab) >= 3; // delete (Full)

// Inventory write access follows the module the stock belongs to, exactly as the
// server's _requireInvWrite: the kitchen INVENTORY grant covers every module, and
// each module's own tab covers that module. Hotel, Spa and Events share one
// inventory screen, which used to check INVENTORY alone — so a role granted
// "Hotel Inventory = Full" saw no Add button.
export const INV_MODULE_TAB: Record<string, string> = {
  RESTAURANT: 'INVENTORY', HOTEL: 'HOTEL_INVENTORY', SPA: 'SPA_INVENTORY', EVENTS: 'INVENTORY_EVENTS',
};
const invTab = (module?: string) => INV_MODULE_TAB[String(module || '').toUpperCase()];
export const canWriteInventory = (module?: string): boolean =>
  canWriteTab('INVENTORY') || (!!invTab(module) && canWriteTab(invTab(module)));
export const canDeleteInventory = (module?: string): boolean =>
  canDeleteTab('INVENTORY') || (!!invTab(module) && canDeleteTab(invTab(module)));

export const canSeeTab = (tab: string): boolean => tabLevel(tab) >= 1;
// The pages of each module, in the order a home button should try them. A user
// sees a module tile only if they can open at least one of them, and the tile
// opens the first one they can — not a fixed page they may not hold (the Events
// tile used to open the Dashboard, which a Bookings-only role cannot see).
export const MODULE_HOME_TABS: Record<'HOTEL' | 'RESTAURANT' | 'SPA' | 'EVENTS', string[]> = {
  HOTEL: ['HOTEL_BOOKINGS', 'ROOMS', 'FOLIOS', 'SERVICE_REQUESTS', 'SERVICES', 'HOUSEKEEPING', 'COMPLIANCE', 'FRONT_OFFICE_REPORTS', 'CONCIERGE_FAQ', 'CHANNEL_MANAGER', 'PUBLIC_BOOKING_PAGE', 'HOTEL_INVENTORY'],
  RESTAURANT: ['MONITOR', 'ORDERS', 'INVOICES', 'MENU', 'INVENTORY', 'LOYALTY', 'QR', 'DELIVERY', 'BOOKINGS', 'RESTAURANT_REPORTS', 'FEEDBACK'],
  SPA: ['SPA_CALENDAR', 'SPA_APPOINTMENTS', 'SPA_CATALOG', 'SPA_RESOURCES', 'SPA_CLIENTS', 'SPA_PACKAGES', 'SPA_REPORTS', 'SPA_BILLING', 'SPA_INVENTORY', 'SPA_SETTINGS'],
  EVENTS: ['EVENTS_DASHBOARD', 'EVENTS_CALENDAR', 'EVENTS_BOOKINGS', 'EVENTS_VENUES', 'EVENTS_RENTALS', 'EVENTS_SERVICES', 'EVENTS_CATERING', 'EVENTS_QUOTATIONS', 'EVENTS_REPORTS', 'EVENTS_SETTINGS', 'EVENTS_ADDONS', 'EVENTS_CHECKLISTS'],
};
export const firstOpenTab = (module: keyof typeof MODULE_HOME_TABS): string | null =>
  MODULE_HOME_TABS[module].find(t => canSeeTab(t)) || null;
