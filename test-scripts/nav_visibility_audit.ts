/**
 * NAV-VISIBILITY AUDIT — deterministic, headless, no server needed.
 *
 * This is the "catch it before the client does" test for nav LEAKS. It imports
 * the SINGLE source of truth (src/navVisibility.ts) and, for a matrix of real
 * roles, asserts the EXACT set of tabs that would render — including the
 * derived/leak-prone rules a pure /my-permissions (API) check can never see:
 *   - the Events "Cleaning Checklist" that borrows the HOUSEKEEPING permission
 *     but lives under the Events group (the repeatedly-reported bug),
 *   - owner-only tabs (Room Setup / Kitchen Printers / Print Format / Staff Access),
 *   - hard-gated finance & HR/payroll tabs that must NOT leak under a fail-open
 *     null permission list.
 *
 * Run:  npx tsx test-scripts/nav_visibility_audit.ts
 * Exit: 0 = all invariants hold, 1 = a leak/denial was found.
 */
import { computeTabVisibility, type NavVisibilityCtx } from '../src/navVisibility';

// ── Tab universe (id + which business side must be enabled to render) ─────────
type Req = 'hotel' | 'restaurant' | 'spa' | 'events' | undefined;
const TABS: { id: string; req?: Req }[] = [
  { id: 'MY_CHECKLIST' }, { id: 'CHECKLIST_BOARD' }, { id: 'CHECKLISTS' },
  { id: 'MONITOR' }, { id: 'INVOICES' },
  { id: 'HOTEL_BOOKINGS', req: 'hotel' }, { id: 'ROOMS', req: 'hotel' }, { id: 'STATUS_BOARD', req: 'hotel' },
  { id: 'ROOM_SETUP', req: 'hotel' }, { id: 'FRONT_OFFICE_REPORTS', req: 'hotel' }, { id: 'SERVICE_REQUESTS', req: 'hotel' },
  { id: 'HOUSEKEEPING', req: 'hotel' }, { id: 'SERVICES', req: 'hotel' }, { id: 'FOLIOS', req: 'hotel' },
  { id: 'COMPLIANCE', req: 'hotel' }, { id: 'CONCIERGE_FAQ', req: 'hotel' },
  { id: 'ORDERS', req: 'restaurant' }, { id: 'MENU', req: 'restaurant' }, { id: 'QR', req: 'restaurant' },
  { id: 'BOOKINGS', req: 'restaurant' }, { id: 'DELIVERY', req: 'restaurant' }, { id: 'KITCHEN_PRINTERS', req: 'restaurant' },
  { id: 'PRINT_TEMPLATES', req: 'restaurant' }, { id: 'RESTAURANT_REPORTS', req: 'restaurant' },
  { id: 'SPA_CALENDAR', req: 'spa' }, { id: 'SPA_APPOINTMENTS', req: 'spa' }, { id: 'SPA_CATALOG', req: 'spa' },
  { id: 'SPA_RESOURCES', req: 'spa' }, { id: 'SPA_CLIENTS', req: 'spa' }, { id: 'SPA_PACKAGES', req: 'spa' },
  { id: 'SPA_REPORTS', req: 'spa' }, { id: 'SPA_BILLING', req: 'spa' }, { id: 'SPA_SETTINGS', req: 'spa' },
  { id: 'EVENTS_DASHBOARD', req: 'events' }, { id: 'EVENTS_CALENDAR', req: 'events' }, { id: 'EVENTS_BOOKINGS', req: 'events' },
  { id: 'EVENTS_VENUES', req: 'events' }, { id: 'EVENTS_RENTALS', req: 'events' }, { id: 'EVENTS_SERVICES', req: 'events' },
  { id: 'EVENTS_CATERING', req: 'events' }, { id: 'EVENTS_QUOTATIONS', req: 'events' }, { id: 'EVENTS_HOUSEKEEPING', req: 'events' },
  { id: 'EVENTS_REPORTS', req: 'events' }, { id: 'EVENTS_MIGRATION', req: 'events' }, { id: 'EVENTS_SETTINGS', req: 'events' },
  { id: 'PROCUREMENT' }, { id: 'EXPENSE_JOURNAL' }, { id: 'RECEIVABLES', req: 'hotel' },
  { id: 'ACCOUNTS_VENDOR_AGING' }, { id: 'ACCOUNTS_PNL' }, { id: 'ACCOUNTS_CASHFLOW' }, { id: 'ACCOUNTS_GST' }, { id: 'ACCOUNTING' },
  { id: 'CASH_DRAWER' },
  { id: 'HOTEL_INVENTORY', req: 'hotel' }, { id: 'INVENTORY', req: 'restaurant' }, { id: 'SPA_INVENTORY', req: 'spa' },
  { id: 'CHANNEL_MANAGER', req: 'hotel' }, { id: 'PUBLIC_BOOKING_PAGE', req: 'hotel' }, { id: 'LOYALTY' }, { id: 'FEEDBACK' },
  { id: 'ALL_REPORTS' },
  { id: 'STAFF' }, { id: 'ATTENDANCE' }, { id: 'ROSTER' }, { id: 'TIMESHEET' }, { id: 'STAFF_PAYROLL' }, { id: 'HR_PAYROLL' },
  { id: 'SETTINGS' }, { id: 'STAFF_ACCESS' }, { id: 'NOTIFICATIONS' }, { id: 'SUBSCRIPTION' },
];

interface Scenario {
  name: string;
  enabled: { hotel: boolean; restaurant: boolean; spa: boolean; events: boolean };
  isOwnerOrAdmin?: boolean;
  isPlatformAdmin?: boolean;
  currentRole: string;
  /** null = no restriction (fail-open built-in role); array = complete grant. */
  grants: string[] | null;
  mustShow: string[];   // these MUST render
  mustHide: string[];   // these MUST NOT render (leak check)
}

// Model the app's real base predicates from a role's grant list.
function ctxFor(s: Scenario): NavVisibilityCtx {
  const g = s.grants;
  const complete = Array.isArray(g);
  return {
    isOwnerOrAdmin: !!s.isOwnerOrAdmin,
    isPlatformAdmin: !!s.isPlatformAdmin,
    currentRole: s.currentRole,
    isHotelEnabled: s.enabled.hotel,
    isEventsEnabled: s.enabled.events,
    isSpaEnabled: s.enabled.spa,
    hasEventsGrant: complete ? g!.some(t => t.startsWith('EVENTS_')) : false,
    // isTabVisible semantics: HOME always; null/empty list = no restriction;
    // a COMPLETE list (custom role) grandfathers nothing → visible iff present.
    baseTabVisible: (id) => id === 'HOME' ? true : (!complete ? true : g!.includes(id)),
    strictGranted: (id) => complete && g!.includes(id),
  };
}
const reqOk = (req: Req, e: Scenario['enabled']) => !req || e[req];
function renders(id: string, s: Scenario): boolean {
  const tab = TABS.find(t => t.id === id)!;
  return reqOk(tab.req, s.enabled) && computeTabVisibility(id, ctxFor(s));
}
function visibleSet(s: Scenario): string[] {
  return TABS.filter(t => reqOk(t.req, s.enabled) && computeTabVisibility(t.id, ctxFor(s))).map(t => t.id);
}

const ALL_EVENTS = TABS.filter(t => t.id.startsWith('EVENTS_')).map(t => t.id);
const ALL_FINANCE = ['PROCUREMENT', 'EXPENSE_JOURNAL', 'RECEIVABLES', 'ACCOUNTS_VENDOR_AGING', 'ACCOUNTS_PNL', 'ACCOUNTS_CASHFLOW', 'ACCOUNTS_GST', 'ACCOUNTING'];
const OWNER_ONLY = ['ROOM_SETUP', 'KITCHEN_PRINTERS', 'PRINT_TEMPLATES', 'STAFF_ACCESS'];
const HR = ['HR_PAYROLL', 'STAFF_PAYROLL'];

const SCENARIOS: Scenario[] = [
  {
    // THE reported bug: hotel Manager, Events enabled but every Events perm = N/A.
    name: 'Hotel Manager (Events = N/A)',
    enabled: { hotel: true, restaurant: false, spa: false, events: true },
    currentRole: 'CUSTOM_MANAGER_MTGS99CJ',
    grants: ['HOTEL_BOOKINGS', 'ROOMS', 'STATUS_BOARD', 'SERVICES', 'SERVICE_REQUESTS', 'HOUSEKEEPING', 'FOLIOS', 'CHECKLISTS', 'MONITOR'],
    mustShow: ['HOTEL_BOOKINGS', 'ROOMS', 'HOUSEKEEPING', 'CHECKLISTS', 'MY_CHECKLIST', 'STATUS_BOARD'],
    mustHide: [...ALL_EVENTS, ...ALL_FINANCE, ...HR, ...OWNER_ONLY, 'CASH_DRAWER'],
  },
  {
    // Events staff WITH housekeeping → the cleaning checklist is legitimately theirs.
    name: 'Events staff (Bookings + Housekeeping)',
    enabled: { hotel: true, restaurant: false, spa: false, events: true },
    currentRole: 'CUSTOM_EVENTS_X',
    grants: ['EVENTS_BOOKINGS', 'EVENTS_VENUES', 'EVENTS_REPORTS', 'HOUSEKEEPING'],
    mustShow: ['EVENTS_BOOKINGS', 'EVENTS_HOUSEKEEPING', 'HOUSEKEEPING', 'MY_CHECKLIST'],
    mustHide: [...ALL_FINANCE, ...HR, ...OWNER_ONLY, 'ORDERS', 'SPA_CALENDAR'],
  },
  {
    // Events staff WITHOUT housekeeping → cleaning checklist must NOT appear.
    name: 'Events staff (no Housekeeping grant)',
    enabled: { hotel: true, restaurant: false, spa: false, events: true },
    currentRole: 'CUSTOM_EVENTS_Y',
    grants: ['EVENTS_BOOKINGS', 'EVENTS_VENUES'],
    mustShow: ['EVENTS_BOOKINGS', 'EVENTS_VENUES', 'MY_CHECKLIST'],
    mustHide: ['EVENTS_HOUSEKEEPING', 'HOUSEKEEPING', ...ALL_FINANCE, ...OWNER_ONLY],
  },
  {
    // Restaurant cashier (CUSTOM role — the CASHIER shortcut must NOT fire).
    name: 'Restaurant cashier (custom role)',
    enabled: { hotel: false, restaurant: true, spa: false, events: false },
    currentRole: 'CUSTOM_CASHIER_Z',
    grants: ['ORDERS', 'MENU', 'MONITOR', 'INVOICES', 'QR'],
    mustShow: ['ORDERS', 'MENU', 'MONITOR', 'MY_CHECKLIST'],
    mustHide: [...ALL_FINANCE, ...HR, ...OWNER_ONLY, 'CASH_DRAWER', ...ALL_EVENTS, 'HOTEL_BOOKINGS', 'STATUS_BOARD'],
  },
  {
    // Finance-only role: exactly the granted finance tabs, nothing more.
    name: 'Finance-only role',
    enabled: { hotel: true, restaurant: true, spa: false, events: false },
    currentRole: 'CUSTOM_ACCOUNTANT_A',
    grants: ['PROCUREMENT', 'ACCOUNTING', 'EXPENSE_JOURNAL'],
    mustShow: ['PROCUREMENT', 'ACCOUNTING', 'EXPENSE_JOURNAL', 'MY_CHECKLIST'],
    mustHide: ['ACCOUNTS_GST', 'ACCOUNTS_PNL', 'RECEIVABLES', ...HR, ...OWNER_ONLY, 'ORDERS', 'HOTEL_BOOKINGS'],
  },
  {
    // Deny-by-default role: complete-but-empty grant → nothing but the personal queue.
    name: 'Deny-all role',
    enabled: { hotel: true, restaurant: true, spa: true, events: true },
    currentRole: 'CUSTOM_LOCKED_B',
    grants: [],
    mustShow: ['MY_CHECKLIST'],
    mustHide: [...ALL_EVENTS, ...ALL_FINANCE, ...HR, ...OWNER_ONLY, 'ORDERS', 'HOTEL_BOOKINGS', 'CASH_DRAWER', 'STATUS_BOARD', 'CHECKLISTS'],
  },
  {
    // CRITICAL: a built-in role with NO configured matrix row resolves to a
    // null (fail-open) list. Sensitive modules must STILL be hard-gated shut.
    name: 'Built-in role, null (fail-open) list',
    enabled: { hotel: true, restaurant: true, spa: false, events: true },
    currentRole: 'CHEF',
    grants: null,
    mustShow: ['ORDERS', 'MENU', 'MY_CHECKLIST'],   // plain tabs still show under null list
    mustHide: [...ALL_FINANCE, ...HR, 'STATUS_BOARD', 'CHECKLIST_BOARD', ...OWNER_ONLY, 'EVENTS_HOUSEKEEPING'],
  },
  {
    // Owner sees everything (all modules enabled).
    name: 'Owner',
    enabled: { hotel: true, restaurant: true, spa: true, events: true },
    isOwnerOrAdmin: true,
    currentRole: 'OWNER',
    grants: null,
    mustShow: [...OWNER_ONLY.filter(t => t !== 'EVENTS_MIGRATION'), ...ALL_FINANCE, 'EVENTS_HOUSEKEEPING', 'HR_PAYROLL', 'CASH_DRAWER', 'ORDERS', 'HOTEL_BOOKINGS'],
    mustHide: ['EVENTS_MIGRATION'],   // super-admin only, hidden even from owner
  },
  {
    // Super-admin/platform operator — Data Migration becomes visible.
    name: 'Platform admin',
    enabled: { hotel: false, restaurant: false, spa: false, events: true },
    isOwnerOrAdmin: true,
    isPlatformAdmin: true,
    currentRole: 'SUPER_ADMIN',
    grants: null,
    mustShow: ['EVENTS_MIGRATION', 'EVENTS_HOUSEKEEPING'],
    mustHide: ['ORDERS', 'HOTEL_BOOKINGS'],
  },
];

// ── Run ───────────────────────────────────────────────────────────────────
let failures = 0;
console.log('\n' + '='.repeat(72) + '\n  NAV-VISIBILITY AUDIT — exact per-role tab set (headless)\n' + '='.repeat(72) + '\n');
for (const s of SCENARIOS) {
  const leaks = s.mustHide.filter(id => renders(id, s));            // shown but must be hidden
  const denials = s.mustShow.filter(id => !renders(id, s));         // hidden but must be shown
  const ok = leaks.length === 0 && denials.length === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${s.name}`);
  if (leaks.length)   console.log(`         🔴 LEAK  (visible but must be hidden): ${leaks.join(', ')}`);
  if (denials.length) console.log(`         🟠 DENY  (hidden but must be shown):  ${denials.join(', ')}`);
  if (!ok)            console.log(`         visible set = [${visibleSet(s).join(', ')}]`);
}
console.log('\n' + '='.repeat(72) + `\n  RESULT — ${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios pass` +
  (failures ? `  ·  ${failures} FAILED` : '  ·  no nav leaks') + '\n' + '='.repeat(72) + '\n');
process.exit(failures > 0 ? 1 : 0);
