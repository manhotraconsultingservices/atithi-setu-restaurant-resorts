/**
 * navVisibility — the SINGLE source of truth for "should this nav tab render
 * for this role?", extracted out of App.tsx so it can be unit-tested headlessly
 * (test-scripts/nav_visibility_audit.ts) instead of only discovered in front of
 * a client.
 *
 * WHY A SEPARATE MODULE
 *   Most tabs are visible iff the role was granted them (plain isTabVisible).
 *   A handful are "derived": their visibility is computed from a DIFFERENT
 *   signal than their own tab id — owner-only tabs, always-on personal tabs,
 *   role-shortcut tabs, and (the dangerous class) a tab surfaced under a second
 *   nav module that borrows another module's permission. The Events "Cleaning
 *   Checklist" (EVENTS_HOUSEKEEPING) reuses the HOUSEKEEPING permission but
 *   lives under the Events group — so a hotel role with Housekeeping but Events
 *   = N/A pulled the whole Events group into view. That class is invisible to a
 *   pure /my-permissions (API) check because the leaking tab id is NOT in the
 *   granted list — it's derived. Centralizing every derived rule here lets one
 *   deterministic test assert the exact visible set for any role, so a leak is
 *   caught before a client ever sees it.
 *
 *   Keep this file free of React / DOM imports so `tsx` can import it directly.
 */

export interface NavVisibilityCtx {
  /** OWNER / SUPER_ADMIN / CTO — the unrestricted roles. */
  isOwnerOrAdmin: boolean;
  /** platform (super-admin) operator — gates EVENTS_MIGRATION. */
  isPlatformAdmin: boolean;
  /** the caller's role id (built-in constant or CUSTOM_<NAME>_<ts>). */
  currentRole: string | null | undefined;
  isHotelEnabled: boolean;
  isEventsEnabled: boolean;
  isSpaEnabled: boolean;
  /** true when the role holds ANY EVENTS_* tab grant (drives the Events group). */
  hasEventsGrant: boolean;
  /**
   * Grandfather-aware visibility of a tab against the role's allowedTabs — the
   * same predicate the rest of the app uses (isTabVisible(id, allowedTabs)).
   * For a modern CUSTOM role (list carries __perm_complete__) this reduces to
   * strict membership; for legacy/markerless lists it applies grandfathering.
   */
  baseTabVisible: (id: string) => boolean;
  /**
   * STRICT membership: allowedTabs.includes(id). Used by the hard-gated
   * modules (finance, HR/payroll, Status Board, Checklist Board) so they never
   * leak under a fail-open null list — a genuine grant still shows them.
   */
  strictGranted: (id: string) => boolean;
}

/** Owner-only tabs — never visible to any non-owner role, grant or not. */
export const OWNER_ONLY_TABS = ['ROOM_SETUP', 'KITCHEN_PRINTERS', 'PRINT_TEMPLATES'] as const;

/** Finance module tabs — hard-gated to owner / MANAGER / explicit grant. */
export const FINANCE_TABS = [
  'PROCUREMENT', 'EXPENSE_JOURNAL', 'RECEIVABLES', 'ACCOUNTS_PNL',
  'ACCOUNTS_CASHFLOW', 'ACCOUNTS_GST', 'ACCOUNTS_VENDOR_AGING', 'ACCOUNTING',
] as const;

/** Built-in ops roles that keep Status Board without an explicit grant. */
const STATUS_BOARD_OPS_ROLES = ['FRONT_DESK', 'HOUSEKEEPING', 'CONCIERGE', 'MAINTENANCE', 'EVENTS_MANAGER'];

/**
 * Decide whether a nav tab is visible for a role. This mirrors, branch for
 * branch, the isVisible() closure in App.tsx — keep the two in lockstep (the
 * App now delegates to this function, so there is a single source).
 */
export function computeTabVisibility(id: string, ctx: NavVisibilityCtx): boolean {
  const {
    isOwnerOrAdmin, isPlatformAdmin, currentRole,
    isHotelEnabled, isEventsEnabled, isSpaEnabled,
    hasEventsGrant, baseTabVisible, strictGranted,
  } = ctx;

  // Owner-only, HARD-gated (never fall through to a fail-open null list). Staff
  // Access was previously only kept safe by being dropped from the nav array for
  // non-owners; gate it here too so the decision is single-source and layered.
  if (id === 'STAFF_ACCESS') return isOwnerOrAdmin;
  if (id === 'ROOM_SETUP') return isOwnerOrAdmin;
  if (id === 'KITCHEN_PRINTERS') return isOwnerOrAdmin;
  if (id === 'PRINT_TEMPLATES') return isOwnerOrAdmin;

  // Checklist Templates: owner/admin always, plus any role granted it.
  if (id === 'CHECKLISTS') return isOwnerOrAdmin || baseTabVisible(id);
  // Event checklist config — owner OR granted, only when Events is enabled.
  if (id === 'EVENTS_CHECKLISTS') return (isOwnerOrAdmin || baseTabVisible(id)) && isEventsEnabled;
  // Data Migration = super-admin only (hidden from tenant owner/staff).
  if (id === 'EVENTS_MIGRATION') return isPlatformAdmin && isEventsEnabled;
  // Personal work queue — visible to every staff member.
  if (id === 'MY_CHECKLIST') return true;
  // Checklist Board — owner / MANAGER / explicit grant.
  if (id === 'CHECKLIST_BOARD') return isOwnerOrAdmin || currentRole === 'MANAGER' || strictGranted(id);

  // Status Board — module-gated + owner/manager, built-in ops roles, or grant.
  if (id === 'STATUS_BOARD') {
    if (!(isHotelEnabled || isEventsEnabled)) return false;
    if (isOwnerOrAdmin || currentRole === 'MANAGER') return true;
    if (STATUS_BOARD_OPS_ROLES.includes(currentRole || '')) return true;
    return strictGranted(id);
  }

  // Finance tabs — hard-gated (never leak under a null list).
  if ((FINANCE_TABS as readonly string[]).includes(id)) {
    return isOwnerOrAdmin || currentRole === 'MANAGER' || strictGranted(id);
  }

  // Cash Drawer — cash-handling roles directly, plus grant.
  if (id === 'CASH_DRAWER') {
    return isOwnerOrAdmin || currentRole === 'MANAGER' || currentRole === 'CASHIER'
      || currentRole === 'FRONT_DESK' || baseTabVisible(id);
  }

  // HR & operational payroll — sensitive salary data, hard-gated.
  if (id === 'HR_PAYROLL' || id === 'STAFF_PAYROLL') {
    return isOwnerOrAdmin || currentRole === 'MANAGER' || strictGranted(id);
  }

  // Spa Billing — module-gated + permissionable.
  if (id === 'SPA_BILLING') return isSpaEnabled && (isOwnerOrAdmin || baseTabVisible(id));

  // Events "Cleaning Checklist" reuses the HOUSEKEEPING permission but lives
  // under the Events nav — so it must ALSO require some Events access, or a
  // hotel role with Housekeeping but Events = N/A pulls the Events group in.
  if (id === 'EVENTS_HOUSEKEEPING') {
    if (isOwnerOrAdmin) return baseTabVisible('HOUSEKEEPING');
    return hasEventsGrant && baseTabVisible('HOUSEKEEPING');
  }

  return baseTabVisible(id);
}
