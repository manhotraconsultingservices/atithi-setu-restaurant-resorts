// ═══════════════════════════════════════════════════════════════════════════
// hrService.ts — HR module tables and pure helpers (HRMS R1, Sep 2026)
// ═══════════════════════════════════════════════════════════════════════════
//
// createHrTables runs from _initTenantDb (db.ts) for every tenant at start-up.
// Payroll tables and staff pay columns used to be created inside requests
// (ensurePayrollTables, the staff settings route, the events roster picker);
// they are created here instead, once per tenant per process.
//
// Everything is additive: new tables, and nullable columns on attendance_staff.
// Helpers below are pure (no DB) so they can be tested offline.
// ═══════════════════════════════════════════════════════════════════════════

import type { DbInterface } from './db.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const HR_MASTER_KINDS = ['DEPARTMENT', 'DESIGNATION', 'GRADE', 'COST_CENTRE'] as const;
export type HrMasterKind = typeof HR_MASTER_KINDS[number];

/** attendance_staff column that links an employee to each kind of master, and
 *  the free-text column kept in step with the master's name (read by payslips,
 *  the directory and older screens). */
export const HR_MASTER_LINKS: Record<HrMasterKind, { column: string; textColumn: string | null; label: string }> = {
  DEPARTMENT:  { column: 'department_id',  textColumn: 'department',  label: 'department' },
  DESIGNATION: { column: 'designation_id', textColumn: 'designation', label: 'designation' },
  GRADE:       { column: 'grade_id',       textColumn: null,          label: 'grade' },
  COST_CENTRE: { column: 'cost_centre_id', textColumn: null,          label: 'cost centre' },
};

export const EMPLOYMENT_TYPES = ['PERMANENT', 'PROBATION', 'FIXED_TERM', 'CASUAL', 'TRAINEE', 'CONTRACTOR'] as const;

/** Settings the HR module reads, with their defaults. Stored as JSON in
 *  hr_settings; later releases add keys here. */
export const HR_SETTINGS_DEFAULTS: Record<string, any> = {
  auto_employee_code: false,   // give new staff the next EMP-#### code automatically
};

export async function createHrTables(db: DbInterface): Promise<void> {
  // ── Payroll tables and staff pay columns (moved from request handlers) ──
  await db.exec(`ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS default_hours DOUBLE PRECISION DEFAULT 8`).catch(() => {});
  await db.exec(`ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS pay_type TEXT DEFAULT 'HOURLY'`).catch(() => {});
  await db.exec(`ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS monthly_wage DOUBLE PRECISION DEFAULT 0`).catch(() => {});
  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff_advances (
      id           TEXT PRIMARY KEY,
      staff_id     TEXT NOT NULL,
      amount       DOUBLE PRECISION DEFAULT 0,
      advance_date DATE,
      note         TEXT,
      recovered    DOUBLE PRECISION DEFAULT 0,
      status       TEXT DEFAULT 'OPEN',
      recorded_by  TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_staff_adv ON staff_advances(staff_id, status)`).catch(() => {});
  await db.exec(`ALTER TABLE staff_advances ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'CASH'`).catch(() => {});
  await db.exec(`ALTER TABLE staff_advances ADD COLUMN IF NOT EXISTS payment_reference TEXT`).catch(() => {});
  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff_payroll (
      id               TEXT PRIMARY KEY,
      staff_id         TEXT NOT NULL,
      period           TEXT NOT NULL,
      pay_type         TEXT,
      units            DOUBLE PRECISION DEFAULT 0,
      rate             DOUBLE PRECISION DEFAULT 0,
      gross            DOUBLE PRECISION DEFAULT 0,
      advance_deducted DOUBLE PRECISION DEFAULT 0,
      net              DOUBLE PRECISION DEFAULT 0,
      status           TEXT DEFAULT 'DRAFT',
      paid_at          TIMESTAMP,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_payroll_period ON staff_payroll(staff_id, period)`).catch(() => {});
  await db.exec(`ALTER TABLE staff_payroll ADD COLUMN IF NOT EXISTS pay_method TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE staff_payroll ADD COLUMN IF NOT EXISTS pay_reference TEXT`).catch(() => {});

  // ── Employee record (R1) ──
  const staffColumns = [
    'employee_code TEXT',
    'employment_type TEXT',
    'reporting_manager_id TEXT',
    'department_id TEXT',
    'designation_id TEXT',
    'grade_id TEXT',
    'cost_centre_id TEXT',
    'probation_end_date DATE',
    'confirmation_date DATE',
    'notice_period_days INT',
    'date_of_leaving DATE',
  ];
  for (const col of staffColumns) {
    await db.exec(`ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_staff_employee_code ON attendance_staff (employee_code) WHERE employee_code IS NOT NULL`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_staff_manager ON attendance_staff (reporting_manager_id)`).catch(() => {});

  // ── Organisation masters: departments, designations, grades, cost centres ──
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hr_masters (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      parent_id   TEXT,
      is_active   INT DEFAULT 1,
      sort_order  INT DEFAULT 0,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (kind, code)
    )
  `).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_masters_kind ON hr_masters (kind, is_active)`).catch(() => {});

  // ── Who saw or exported full ID and bank numbers (HRMS-R1B) ──
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hr_sensitive_access_log (
      id          TEXT PRIMARY KEY,
      staff_id    TEXT,
      action      TEXT NOT NULL,
      detail      TEXT,
      actor_id    TEXT,
      actor_email TEXT,
      actor_role  TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_sensitive_log ON hr_sensitive_access_log (staff_id, created_at)`).catch(() => {});

  // ── Private HR documents (HRMS-R1C) ──
  // The file is stored encrypted under file_key (R2 or disk) and the number on the
  // document is an hr1: value like PAN. Nothing in this table is a public address.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hr_documents (
      id               TEXT PRIMARY KEY,
      staff_id         TEXT NOT NULL,
      doc_type         TEXT NOT NULL,
      title            TEXT,
      doc_number       TEXT,
      issuing_country  TEXT,
      issue_date       DATE,
      expiry_date      DATE,
      storage          TEXT,
      file_key         TEXT,
      file_name        TEXT,
      mime_type        TEXT,
      size_bytes       INT,
      notes            TEXT,
      verified_by      TEXT,
      verified_at      TIMESTAMP,
      last_alert_stage TEXT,
      last_alert_at    TIMESTAMP,
      uploaded_by      TEXT,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_documents_staff ON hr_documents (staff_id)`).catch(() => {});
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_hr_documents_expiry ON hr_documents (expiry_date)`).catch(() => {});

  // ── HR settings (one row per tenant, JSON) ──
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hr_settings (
      id          TEXT PRIMARY KEY DEFAULT 'SINGLETON',
      settings    TEXT NOT NULL DEFAULT '{}',
      updated_by  TEXT,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
}

// ─────────────────────────── pure helpers ───────────────────────────

/** A master code: upper case letters, digits, - and _, at most 20 characters. */
export function normaliseMasterCode(v: any): string {
  return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
}

/** True when making `managerId` the manager of `staffId` would close a loop:
 *  walking up from the manager reaches the employee. `managerOf` maps each
 *  employee id to their current manager id. */
export function wouldCreateManagerCycle(staffId: string, managerId: string, managerOf: Map<string, string | null>): boolean {
  if (!managerId) return false;
  if (managerId === staffId) return true;
  const seen = new Set<string>();
  let cur: string | null = managerId;
  while (cur) {
    if (cur === staffId) return true;
    if (seen.has(cur)) return false;   // an existing loop elsewhere is not this change's doing
    seen.add(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return false;
}

/** EMP-0001 style code for number n. */
export function formatEmployeeCode(n: number): string {
  return `EMP-${String(Math.max(1, Math.floor(n))).padStart(4, '0')}`;
}

/** The next EMP-#### code after the highest one in use. */
export function nextEmployeeCodeFrom(existing: Array<string | null | undefined>): string {
  let max = 0;
  for (const c of existing) {
    const m = /^EMP-(\d+)$/.exec(String(c || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatEmployeeCode(max + 1);
}

const _normForDiff = (v: any): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 10);
  return s;
};

/** Fields that changed between two rows, with before and after values run
 *  through `mask` (used to keep ID and bank numbers masked in history). */
export function diffFields(before: any, after: any, keys: string[], mask?: (key: string, value: any) => any): { keys: string[]; before: Record<string, any>; after: Record<string, any> } {
  const out = { keys: [] as string[], before: {} as Record<string, any>, after: {} as Record<string, any> };
  for (const k of keys) {
    const b = _normForDiff(before?.[k]);
    const a = _normForDiff(after?.[k]);
    if (b === a) continue;
    out.keys.push(k);
    out.before[k] = mask ? mask(k, b) : b;
    out.after[k] = mask ? mask(k, a) : a;
  }
  return out;
}

// ─────────────────────── sensitive numbers at rest (HRMS-R1B) ───────────────────────
// PAN, Aadhaar and bank account are stored AES-256-GCM encrypted in their own
// columns as "hr1:<iv>:<tag>:<data>". A value without the prefix is one saved
// before encryption and is read as it is. The key is HR_DATA_KEY (base64, 32
// bytes) when set, otherwise derived from JWT_SECRET; decryption tries both, so
// setting HR_DATA_KEY later keeps older values readable. Changing JWT_SECRET
// without HR_DATA_KEY makes values encrypted under the old secret unreadable.
export const HR_ENCRYPTED_FIELDS = ['pan', 'aadhaar', 'bank_account'] as const;

function _hrDataKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const raw = process.env.HR_DATA_KEY;
  if (raw) {
    try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) keys.push(b); } catch { /* ignore a malformed key */ }
  }
  keys.push(createHash('sha256').update(`atithi-hr-data-v1:${process.env.JWT_SECRET || 'atithi-setu-fallback'}`).digest());
  return keys;
}

/** Which key new values are encrypted with. */
export function hrDataKeySource(): 'HR_DATA_KEY' | 'JWT_SECRET' {
  const raw = process.env.HR_DATA_KEY;
  try { if (raw && Buffer.from(raw, 'base64').length === 32) return 'HR_DATA_KEY'; } catch { /* fall through */ }
  return 'JWT_SECRET';
}

export function isEncryptedSensitive(v: any): boolean {
  return typeof v === 'string' && v.startsWith('hr1:');
}

export function encryptSensitive(plain: any): string | null {
  if (plain == null || plain === '') return null;
  const s = String(plain);
  if (isEncryptedSensitive(s)) return s;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', _hrDataKeys()[0], iv);
  const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return `hr1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** The plain value; null when it cannot be decrypted with any key. */
export function decryptSensitive(stored: any): string | null {
  if (stored == null || stored === '') return null;
  const v = String(stored);
  if (!isEncryptedSensitive(v)) return v;
  const parts = v.split(':');
  if (parts.length !== 4) return null;
  for (const key of _hrDataKeys()) {
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
      d.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
    } catch { /* try the next key */ }
  }
  return null;
}

/** Plain labels for employee fields, used in history summaries. */
export const HR_FIELD_LABELS: Record<string, string> = {
  name: 'name', phone: 'phone', email: 'email', role: 'role', login_id: 'login ID', is_active: 'active status',
  designation: 'designation', department: 'department', joining_date: 'joining date', ctc: 'CTC',
  pan: 'PAN', aadhaar: 'Aadhaar', uan: 'UAN', esic_number: 'ESIC number',
  bank_account: 'bank account', bank_ifsc: 'IFSC', bank_name: 'bank name',
  emergency_contact_name: 'emergency contact', emergency_contact_phone: 'emergency phone',
  address: 'address', dob: 'date of birth', gender: 'gender', marital_status: 'marital status',
  hourly_rate: 'hourly rate', payroll_id: 'payroll ID', hr_status: 'HR status', notes: 'notes',
  employee_code: 'employee code', employment_type: 'employment type', reporting_manager_id: 'reporting manager',
  department_id: 'department', designation_id: 'designation', grade_id: 'grade', cost_centre_id: 'cost centre',
  probation_end_date: 'probation end', confirmation_date: 'confirmation date', notice_period_days: 'notice period',
  date_of_leaving: 'date of leaving', default_hours: 'default hours', pay_type: 'pay type', monthly_wage: 'monthly wage',
};

// ─────────────────────────── HR documents (HRMS-R1C) ───────────────────────────

export const HR_DOCUMENT_TYPES = [
  'AADHAAR', 'PAN', 'PASSPORT', 'VISA', 'WORK_PERMIT', 'FRRO_REGISTRATION',
  'DRIVING_LICENCE', 'VOTER_ID', 'BANK_PROOF', 'ADDRESS_PROOF', 'PHOTO',
  'EDUCATION', 'EXPERIENCE_LETTER', 'OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONTRACT',
  'MEDICAL_FITNESS', 'FOOD_HANDLER_CERTIFICATE', 'POLICE_VERIFICATION', 'OTHER',
] as const;

export const HR_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  AADHAAR: 'Aadhaar', PAN: 'PAN card', PASSPORT: 'Passport', VISA: 'Visa', WORK_PERMIT: 'Work permit',
  FRRO_REGISTRATION: 'FRRO registration', DRIVING_LICENCE: 'Driving licence', VOTER_ID: 'Voter ID',
  BANK_PROOF: 'Bank proof', ADDRESS_PROOF: 'Address proof', PHOTO: 'Photograph',
  EDUCATION: 'Education certificate', EXPERIENCE_LETTER: 'Experience letter', OFFER_LETTER: 'Offer letter',
  APPOINTMENT_LETTER: 'Appointment letter', CONTRACT: 'Contract', MEDICAL_FITNESS: 'Medical fitness certificate',
  FOOD_HANDLER_CERTIFICATE: 'Food handler certificate', POLICE_VERIFICATION: 'Police verification', OTHER: 'Other document',
};

/** A document type from input: upper case, spaces and hyphens to underscores; null when unknown. */
export function normaliseDocType(v: any): string | null {
  const s = String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (HR_DOCUMENT_TYPES as readonly string[]).includes(s) ? s : null;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isYmd(v: any): boolean {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** YYYY-MM-DD from a pg DATE (a Date at local midnight) or a date string. */
export function ymdOf(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetweenYmd(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export type HrDocumentAlertStage = 'D30' | 'D7' | 'EXPIRED';
const _DOC_STAGE_RANK: Record<string, number> = { D30: 1, D7: 2, EXPIRED: 3 };

/**
 * Where a document stands on `today`: EXPIRED after its expiry date, D7 from seven
 * days before up to and including the expiry date, D30 from thirty days before,
 * otherwise null (no expiry date, or more than thirty days to go).
 */
export function documentExpiryStage(expiry: any, today: string): HrDocumentAlertStage | null {
  const e = ymdOf(expiry);
  if (!e) return null;
  const days = daysBetweenYmd(today, e);
  if (days < 0) return 'EXPIRED';
  if (days <= 7) return 'D7';
  if (days <= 30) return 'D30';
  return null;
}

/** Alert only when a document reaches a later stage than the last alert sent for it. */
export function documentNeedsAlert(stage: HrDocumentAlertStage | null, lastSent: any): boolean {
  if (!stage) return false;
  return (_DOC_STAGE_RANK[stage] || 0) > (_DOC_STAGE_RANK[String(lastSent || '')] || 0);
}

// Stored HR files are HRF1 | iv (12 bytes) | tag (16 bytes) | ciphertext, with the
// same keys as the hr1: values above, so an object read straight from storage is
// unreadable.
const _HR_FILE_MAGIC = Buffer.from('HRF1', 'ascii');

export function encryptFileBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', _hrDataKeys()[0], iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([_HR_FILE_MAGIC, iv, c.getAuthTag(), enc]);
}

/** The original bytes; null when the buffer is not a stored HR file or no key opens it. */
export function decryptFileBuffer(stored: Buffer): Buffer | null {
  if (!Buffer.isBuffer(stored) || stored.length < 32 || !stored.subarray(0, 4).equals(_HR_FILE_MAGIC)) return null;
  const iv = stored.subarray(4, 16), tag = stored.subarray(16, 32), data = stored.subarray(32);
  for (const key of _hrDataKeys()) {
    try {
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]);
    } catch { /* try the next key */ }
  }
  return null;
}

/** A file name safe inside a Content-Disposition header. */
export function safeDownloadName(name: any, fallback = 'document'): string {
  const s = String(name ?? '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);
  return s || fallback;
}
