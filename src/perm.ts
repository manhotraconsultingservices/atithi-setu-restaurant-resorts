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
