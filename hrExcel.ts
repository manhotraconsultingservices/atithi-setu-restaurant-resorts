// ═══════════════════════════════════════════════════════════════════════════
// hrExcel.ts — Excel (.xlsx) export and import helpers (HRMS R1D, Sep 2026)
// ═══════════════════════════════════════════════════════════════════════════
//
// buildWorkbook writes sheets with a bold, frozen header row, a filter and real
// dates. readSheet reads a sheet by header NAME (column order does not matter; a
// trailing * marks a required column in templates) and gives dates as
// YYYY-MM-DD. Imports go validate → preview → commit: validateImportRow is pure
// and runs for the preview and again for every row at commit, so the server
// never trusts what the browser sends back.
// ═══════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import type { Cell } from 'exceljs';
import { EMPLOYMENT_TYPES, isYmd, ymdOf } from './hrService.ts';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type SheetColumn = { key: string; header: string; width?: number; kind?: 'text' | 'number' | 'date' };
export type SheetSpec = { name: string; columns: SheetColumn[]; rows: Array<Record<string, any>> };

export class SheetReadError extends Error {
  code = 'SHEET_UNREADABLE';
}

function _cellValue(v: any, kind?: SheetColumn['kind']): any {
  if (v == null || v === '') return null;
  if (kind === 'date') {
    const ymd = ymdOf(v);
    if (!ymd) return String(v);
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  if (kind === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
}

/** A workbook with one sheet per spec: bold frozen header row, a filter, real dates. */
export async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Atithi-Setu';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.replace(/[\\\/?*[\]:]/g, ' ').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || Math.max(12, c.header.length + 2) }));
    ws.getRow(1).font = { bold: true };
    s.columns.forEach((c, i) => { if (c.kind === 'date') ws.getColumn(i + 1).numFmt = 'yyyy-mm-dd'; });
    for (const r of s.rows) {
      const out: Record<string, any> = {};
      for (const c of s.columns) out[c.key] = _cellValue(r[c.key], c.kind);
      ws.addRow(out);
    }
    if (s.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The text of a cell as a person reads it; dates as YYYY-MM-DD; null when empty or an error. */
export function cellText(cell: Cell): string | null {
  const v: any = cell.value;
  if (v == null) return null;
  const d: any = v instanceof Date ? v : (typeof v === 'object' && v.result instanceof Date ? v.result : null);
  if (d) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  if (typeof v === 'object' && v.error) return null;
  const t = String(cell.text ?? '').trim();
  return t === '' ? null : t;
}

const _normHeader = (s: string) => s.toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();

export type SheetRead = {
  sheet: string;
  headers: string[];
  rows: Array<{ row: number; values: Record<string, string | null> }>;
  missing: string[];
  unknown: string[];
};

/** Filled rows of the first sheet (or `sheetName`), matched to columns by header name. */
export async function readSheet(buf: Buffer, columns: SheetColumn[], opts: { maxRows?: number; sheetName?: string } = {}): Promise<SheetRead> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw new SheetReadError('This file is not an Excel workbook (.xlsx). Save it as .xlsx and choose it again.');
  }
  const ws = (opts.sheetName ? wb.getWorksheet(opts.sheetName) : undefined) || wb.worksheets[0];
  if (!ws) throw new SheetReadError('The workbook has no sheets.');
  const byHeader = new Map<string, SheetColumn>(columns.map((c) => [_normHeader(c.header), c]));
  const colAt = new Map<number, SheetColumn>();
  const headers: string[] = [];
  const unknown: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, n) => {
    const h = cellText(cell);
    if (!h) return;
    headers.push(h);
    const c = byHeader.get(_normHeader(h));
    if (c && ![...colAt.values()].includes(c)) colAt.set(n, c);
    else unknown.push(h);
  });
  const found = new Set([...colAt.values()].map((c) => c.key));
  const missing = columns.filter((c) => !found.has(c.key)).map((c) => c.header);
  const rows: SheetRead['rows'] = [];
  const max = opts.maxRows ?? 1000;
  let filled = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const values: Record<string, string | null> = {};
    let any = false;
    for (const [idx, c] of colAt) {
      const v = cellText(row.getCell(idx));
      values[c.key] = v;
      if (v != null) any = true;
    }
    if (!any) return;
    filled++;
    if (rows.length < max) rows.push({ row: n, values });
  });
  if (filled > max) throw new SheetReadError(`The sheet has ${filled} filled rows; import up to ${max} at a time.`);
  return { sheet: ws.name, headers, rows, missing, unknown };
}

/** YYYY-MM-DD from YYYY-MM-DD or day-first DD/MM/YYYY (also - or .); null when not a real date. */
export function parseImportDate(v: any): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (isYmd(s)) return s;
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!m) return null;
  const ymd = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isYmd(ymd) ? ymd : null;
}

// ─────────────────────────── Employee import ───────────────────────────

export const EMPLOYEE_IMPORT_COLUMNS: SheetColumn[] = [
  { key: 'name', header: 'Name', width: 26 },
  { key: 'role', header: 'Role', width: 20 },
  { key: 'phone', header: 'Phone', width: 16 },
  { key: 'email', header: 'Email', width: 28 },
  { key: 'employee_code', header: 'Employee code', width: 15 },
  { key: 'designation', header: 'Designation', width: 22 },
  { key: 'department', header: 'Department', width: 20 },
  { key: 'employment_type', header: 'Employment type', width: 17 },
  { key: 'joining_date', header: 'Joining date', width: 14, kind: 'date' },
  { key: 'dob', header: 'Date of birth', width: 14, kind: 'date' },
  { key: 'gender', header: 'Gender', width: 10 },
];
export const EMPLOYEE_IMPORT_REQUIRED = ['name', 'role'];

/** The built-in staff roles, offered only while a property has no roles of its own (as in Staff Directory). */
export const BUILTIN_STAFF_ROLES: ImportRole[] = [
  { id: 'CHEF', name: 'Chef' }, { id: 'WAITER', name: 'Waiter' }, { id: 'CASHIER', name: 'Cashier' },
  { id: 'THERAPIST', name: 'Therapist' }, { id: 'MANAGER', name: 'Manager' }, { id: 'FRONT_DESK', name: 'Front Desk' },
  { id: 'HOUSEKEEPING', name: 'Housekeeping' }, { id: 'MAINTENANCE', name: 'Maintenance' }, { id: 'CONCIERGE', name: 'Concierge' },
];

export const EMPLOYMENT_TYPE_WORDS: Record<string, string> = {
  permanent: 'PERMANENT', probation: 'PROBATION', 'on probation': 'PROBATION',
  'fixed term': 'FIXED_TERM', 'fixed-term': 'FIXED_TERM', casual: 'CASUAL', 'casual / daily': 'CASUAL', daily: 'CASUAL',
  trainee: 'TRAINEE', contractor: 'CONTRACTOR',
};
const _GENDER: Record<string, string> = { M: 'M', MALE: 'M', F: 'F', FEMALE: 'F', O: 'O', OTHER: 'O' };

/** Keys that identify an employee: the name with phone digits, and the name with email. */
export function staffMatchKeys(name: any, phone: any, email: any): string[] {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return [];
  const keys: string[] = [];
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits) keys.push(`${n}|${digits}`);
  const e = String(email ?? '').trim().toLowerCase();
  if (e) keys.push(`${n}|${e}`);
  return keys;
}

export type ImportRole = { id: string; name: string };
export type ImportContext = {
  roles: ImportRole[];
  takenCodes: Set<string>;
  existing: Set<string>;
  departments: Map<string, { id: string; name: string }>;
  designations: Map<string, { id: string; name: string }>;
};
export type ImportSeen = { codes: Set<string>; keys: Set<string> };
export type ImportRowResult = {
  row: number;
  status: 'NEW' | 'DUPLICATE' | 'INVALID';
  errors: string[];
  notes: string[];
  data: Record<string, any>;
};

/**
 * One import row checked against the property. Name and a role of this property
 * are required; email, employment type, dates and gender must read; an employee
 * code must be free and not repeated in the file. A row that matches an existing
 * employee or an earlier row (name with phone or email) is DUPLICATE. `seen`
 * carries codes and match keys between rows of one file.
 */
export function validateImportRow(row: number, values: Record<string, any>, ctx: ImportContext, seen: ImportSeen): ImportRowResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const s = (k: string) => String(values?.[k] ?? '').trim();

  const name = s('name').slice(0, 120);
  if (!name) errors.push('Name is missing');
  const roleIn = s('role');
  const role = roleIn
    ? ctx.roles.find((r) => r.id.toUpperCase() === roleIn.toUpperCase() || r.name.trim().toLowerCase() === roleIn.toLowerCase())
    : undefined;
  if (!roleIn) errors.push('Role is missing');
  else if (!role) errors.push(`Role ${roleIn} is not a role at this property`);

  const phone = s('phone').slice(0, 30) || null;
  const email = s('email').slice(0, 120) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`Email ${email} is not an email address`);

  const code = s('employee_code').toUpperCase().slice(0, 30) || null;
  if (code) {
    if (ctx.takenCodes.has(code)) errors.push(`Employee code ${code} is already in use`);
    else if (seen.codes.has(code)) errors.push(`Employee code ${code} is repeated in this file`);
    else seen.codes.add(code);
  }

  const etIn = s('employment_type');
  let employment_type: string | null = null;
  if (etIn) {
    const up = etIn.toUpperCase().replace(/[\s-]+/g, '_');
    employment_type = (EMPLOYMENT_TYPES as readonly string[]).includes(up) ? up : (EMPLOYMENT_TYPE_WORDS[etIn.toLowerCase()] || null);
    if (!employment_type) errors.push(`Employment type ${etIn} is not Permanent, Probation, Fixed term, Casual, Trainee or Contractor`);
  }

  const joining_date = parseImportDate(s('joining_date'));
  if (s('joining_date') && !joining_date) errors.push(`Joining date ${s('joining_date')} is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
  const dob = parseImportDate(s('dob'));
  if (s('dob') && !dob) errors.push(`Date of birth ${s('dob')} is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);

  const gIn = s('gender');
  const gender = gIn ? (_GENDER[gIn.toUpperCase()] || null) : null;
  if (gIn && !gender) errors.push(`Gender ${gIn} is not Male, Female or Other`);

  const fromList = (label: string, text: string, list: Map<string, { id: string; name: string }>) => {
    if (!text) return { name: null as string | null, id: null as string | null };
    const m = list.get(text.toLowerCase());
    if (m) return { name: m.name, id: m.id };
    if (list.size) notes.push(`${label} ${text} is not in the organisation list and is saved as typed`);
    return { name: text.slice(0, 80), id: null };
  };
  const dep = fromList('Department', s('department'), ctx.departments);
  const des = fromList('Designation', s('designation'), ctx.designations);

  const data = {
    name, role: role?.id || null, role_label: role?.name || roleIn || null, phone, email, employee_code: code,
    designation: des.name, designation_id: des.id, department: dep.name, department_id: dep.id,
    employment_type, joining_date, dob, gender,
  };
  if (errors.length) return { row, status: 'INVALID', errors, notes, data };
  const keys = staffMatchKeys(name, phone, email);
  if (keys.some((k) => ctx.existing.has(k))) {
    return { row, status: 'DUPLICATE', errors, notes: [...notes, 'An employee with this name and phone or email already exists'], data };
  }
  if (keys.some((k) => seen.keys.has(k))) {
    return { row, status: 'DUPLICATE', errors, notes: [...notes, 'The same name and phone or email is on an earlier row'], data };
  }
  keys.forEach((k) => seen.keys.add(k));
  return { row, status: 'NEW', errors, notes, data };
}

/** The How to fill sheet of the employee import template, with an example for each column. */
export function importGuideRows(roleNames: string[]): Array<Record<string, string>> {
  return [
    { column: 'Name *', enter: 'Full name. Required.', example: 'Asha Rao' },
    { column: 'Role *', enter: `A role at this property, by name. Required. Roles: ${roleNames.join(', ')}.`, example: roleNames[0] || '' },
    { column: 'Phone', enter: 'Mobile number.', example: '9876543210' },
    { column: 'Email', enter: 'Email address.', example: 'asha.rao@example.com' },
    { column: 'Employee code', enter: 'Leave empty to give codes later, or automatically if that is switched on in Organisation. Must not be in use.', example: 'EMP-0101' },
    { column: 'Designation', enter: 'Matched to the organisation list by name, otherwise saved as typed.', example: 'Front Office Associate' },
    { column: 'Department', enter: 'Matched to the organisation list by name, otherwise saved as typed.', example: 'Front Office' },
    { column: 'Employment type', enter: 'Permanent, Probation, Fixed term, Casual, Trainee or Contractor.', example: 'Permanent' },
    { column: 'Joining date', enter: 'A date cell, or YYYY-MM-DD, or day first as DD/MM/YYYY.', example: '01/04/2026' },
    { column: 'Date of birth', enter: 'A date cell, or YYYY-MM-DD, or day first as DD/MM/YYYY.', example: '15/08/1995' },
    { column: 'Gender', enter: 'Male, Female or Other.', example: 'Female' },
    { column: 'Notes', enter: 'Each row adds an employee without a login; set logins in Staff Directory. PAN, Aadhaar and bank details are not imported, add them on the employee record. Rows matching an employee by name and phone or email are skipped. Up to 500 rows at a time.', example: '' },
  ];
}
