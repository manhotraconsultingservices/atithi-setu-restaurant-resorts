// Single source of truth for turning a stored role id into a human label.
//
// Custom roles (every tenant role is custom now) are stored as
// `CUSTOM_<SLUG>_<base36ts>` — e.g. `CUSTOM_WAITER_01_MTGS99CJ`. The UI must
// NEVER show that raw id; it shows the friendly name ("Waiter 01"). Built-in /
// legacy role tokens (UPPER_SNAKE like OWNER, HR_MANAGER) are Title-Cased;
// already-friendly mixed-case strings pass through unchanged.
//
// Where the caller has the tenant's `customRoles` list, prefer the EXACT name
// (`customRoles.find(r => r.id === role)?.name`) and fall back to this parser;
// where it doesn't (sub-components, exports), this parser alone is enough to
// guarantee no `CUSTOM_…` id ever reaches the screen.
export function prettyRoleLabel(role?: string | null): string {
  const r = String(role ?? '').trim();
  if (!r) return '';
  const m = r.match(/^CUSTOM_(.+)_[A-Za-z0-9]+$/);
  const base = m ? m[1] : r;
  return base
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
