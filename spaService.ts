// ════════════════════════════════════════════════════════════════════════
// Spa & Wellness module — per-tenant schema DDL, seed, and scheduling helpers
// ════════════════════════════════════════════════════════════════════════
//
// Mirrors the Hotel module (createHotelTables / seedDefaultServices in
// server.ts) but lives in its own module to keep server.ts navigable. The
// module is gated by `restaurants.spa_enabled = 1` (default 0 → zero impact
// on every existing tenant). Spa tables are created on-demand from the
// /spa/enable endpoint and re-run at boot for spa-enabled tenants.
//
// Billing reuses the Hotel folio ledger (folios / folio_entries /
// folio_payments). Because a spa-only tenant (property_type='RESTAURANT')
// never had createHotelTables run, createSpaTables ensures those three folio
// tables exist itself (CREATE TABLE IF NOT EXISTS → no-op if hotel already
// made them) plus the spa discriminator columns (folio_kind, appointment_id).
//
// Supply-chain reuse: spa retail / back-bar products are `ingredients` rows
// tagged item_type='SPA_PRODUCT' (consumable) or 'SPA_RETAIL' (take-home),
// so they flow through the validated PO→GRN→supplier-invoice→payment chain
// with zero changes to procurement.

import { DbInterface } from "./db.ts";

// ── Pure time helpers (naive local timestamps, single-region IST app) ──────
// Timestamps are stored as `timestamp without time zone` and passed as
// 'YYYY-MM-DD HH:MM:SS' strings. We do minute arithmetic in JS to avoid any
// timezone drift.

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Build a 'YYYY-MM-DD HH:MM:SS' timestamp string from a date + minutes-since-midnight. */
export function tsFromDateMinutes(date: string, minutes: number): string {
  return `${date} ${minutesToHHMM(minutes)}:00`;
}

/** Day-of-week 0=Sun … 6=Sat for a 'YYYY-MM-DD' date, computed without TZ ambiguity. */
export function dowOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Total booked window (minutes) for a service incl. buffers + selected add-ons. */
export function serviceWindowMinutes(
  service: { duration_min: number; buffer_before_min?: number; buffer_after_min?: number },
  addons: Array<{ extra_duration_min?: number }> = []
): number {
  const base = Number(service.duration_min || 0);
  const before = Number(service.buffer_before_min || 0);
  const after = Number(service.buffer_after_min || 0);
  const addonMins = addons.reduce((s, a) => s + Number(a.extra_duration_min || 0), 0);
  return before + base + addonMins + after;
}

// ── Conflict detection (application-level check-then-insert, matching the
// hotel booking convention — DbInterface exposes no cross-statement txn) ────
// Half-open interval overlap: (newStart < existingEnd) AND (newEnd > existingStart).

/** Returns a conflicting appointment row for a therapist, or null. */
export async function therapistConflict(
  tenantDb: DbInterface, therapistId: string, startAt: any, endAt: any, excludeApptId?: string
): Promise<any | null> {
  // A treatment they assist on takes their time as one they lead does. The
  // lead-only query stands in should the assisting table be missing.
  const leadOnly = () => tenantDb.query(
    `SELECT id, start_at, end_at FROM spa_appointments
      WHERE therapist_id = ?
        AND status NOT IN ('CANCELLED','NO_SHOW')
        AND start_at < ? AND end_at > ?
        ${excludeApptId ? "AND id <> ?" : ""}
      LIMIT 1`,
    excludeApptId ? [therapistId, endAt, startAt, excludeApptId] : [therapistId, endAt, startAt]
  );
  const rows = await tenantDb.query(
    `SELECT a.id, a.start_at, a.end_at FROM spa_appointments a
      WHERE (a.therapist_id = ? OR EXISTS (SELECT 1 FROM spa_appointment_therapists x WHERE x.appointment_id = a.id AND x.therapist_id = ?))
        AND a.status NOT IN ('CANCELLED','NO_SHOW')
        AND a.start_at < ? AND a.end_at > ?
        ${excludeApptId ? "AND a.id <> ?" : ""}
      LIMIT 1`,
    excludeApptId ? [therapistId, therapistId, endAt, startAt, excludeApptId] : [therapistId, therapistId, endAt, startAt]
  ).catch(() => leadOnly());
  return rows[0] || null;
}

/** A timestamp moved by some minutes, as 'YYYY-MM-DD HH:MM:SS'. Accepts the
 *  'YYYY-MM-DD HH:MM[:SS]' strings the module passes around, or a Date as pg
 *  returns a TIMESTAMP (read through its local components, which pg built). */
export function tsShift(ts: any, minutes: number): string {
  let y: number, mo: number, d: number, h: number, mi: number;
  if (ts instanceof Date) {
    y = ts.getFullYear(); mo = ts.getMonth() + 1; d = ts.getDate(); h = ts.getHours(); mi = ts.getMinutes();
  } else {
    const m = String(ts || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return String(ts || "");
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); h = Number(m[4]); mi = Number(m[5]);
  }
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) + Number(minutes || 0) * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}

/** Returns a conflicting appointment row for a resource/cabin, or null. A cabin
 *  with a turnaround needs that many minutes clear on either side of a booking,
 *  for cleaning and resetting. */
export async function resourceConflict(
  tenantDb: DbInterface, resourceId: string, startAt: any, endAt: any, excludeApptId?: string, turnaroundMin: number = 0
): Promise<any | null> {
  const turn = Math.max(0, Number(turnaroundMin || 0));
  const from = turn ? tsShift(startAt, -turn) : startAt;
  const to = turn ? tsShift(endAt, turn) : endAt;
  const rows = await tenantDb.query(
    `SELECT id, start_at, end_at FROM spa_appointments
      WHERE resource_id = ?
        AND status NOT IN ('CANCELLED','NO_SHOW')
        AND start_at < ? AND end_at > ?
        ${excludeApptId ? "AND id <> ?" : ""}
      LIMIT 1`,
    excludeApptId ? [resourceId, to, from, excludeApptId] : [resourceId, to, from]
  );
  return rows[0] || null;
}

// ── Skills ─────────────────────────────────────────────────────────────────
export const SPA_SKILL_LEVELS = ["TRAINEE", "QUALIFIED", "SENIOR"];
/** 1 = trainee … 3 = senior; 0 for anything else. */
export function spaLevelRank(level: any): number {
  const i = SPA_SKILL_LEVELS.indexOf(String(level || "").toUpperCase());
  return i < 0 ? 0 : i + 1;
}

/** The therapists qualified for a service on a date: every skill the service
 *  names, at its minimum level, and — for a skill that needs certification — a
 *  certificate that is recorded and still in date. Null when the service names no
 *  skills, in which case the older rule applies (the therapist is mapped to it). */
export async function spaQualifiedTherapistIds(tenantDb: DbInterface, serviceId: string, date: string): Promise<Set<string> | null> {
  const reqs: any[] = await tenantDb.query(
    `SELECT ss.skill_id, ss.min_level, COALESCE(sk.requires_certification, 0) AS requires_certification
       FROM spa_service_skills ss JOIN spa_skills sk ON sk.id = ss.skill_id
      WHERE ss.service_id = ? AND COALESCE(sk.is_active, 1) = 1`, [serviceId]).catch(() => []);
  if (!reqs.length) return null;
  const ids = reqs.map((r: any) => String(r.skill_id));
  const held: any[] = await tenantDb.query(
    `SELECT therapist_id, skill_id, level, certified_on, valid_until FROM spa_therapist_skills
      WHERE skill_id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => []);
  const byTherapist = new Map<string, Map<string, any>>();
  for (const h of held) {
    const k = String(h.therapist_id);
    if (!byTherapist.has(k)) byTherapist.set(k, new Map());
    byTherapist.get(k)!.set(String(h.skill_id), h);
  }
  const out = new Set<string>();
  for (const [therapistId, skills] of byTherapist) {
    const ok = reqs.every((r: any) => {
      const h = skills.get(String(r.skill_id));
      if (!h) return false;
      if (spaLevelRank(h.level) < spaLevelRank(r.min_level || "QUALIFIED")) return false;
      if (h.valid_until && String(h.valid_until).slice(0, 10) < date) return false;
      if (Number(r.requires_certification) === 1 && !h.certified_on) return false;
      return true;
    });
    if (ok) out.add(therapistId);
  }
  return out;
}

/** FEMALE or MALE; null for anything else (not recorded, other, blank), which
 *  matches no gender rule. */
export function spaGenderCode(v: any): "FEMALE" | "MALE" | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "F" || s === "FEMALE" ? "FEMALE" : s === "M" || s === "MALE" ? "MALE" : null;
}

/** What stands between a therapist and the skills a service needs on a date, in
 *  words — the same rules as spaQualifiedTherapistIds. Null when the service
 *  names no skills. */
export async function spaSkillGaps(tenantDb: DbInterface, serviceId: string, therapistId: string, date: string): Promise<string[] | null> {
  const reqs: any[] = await tenantDb.query(
    `SELECT ss.skill_id, ss.min_level, sk.name, COALESCE(sk.requires_certification, 0) AS requires_certification
       FROM spa_service_skills ss JOIN spa_skills sk ON sk.id = ss.skill_id
      WHERE ss.service_id = ? AND COALESCE(sk.is_active, 1) = 1
      ORDER BY sk.name`, [serviceId]).catch(() => []);
  if (!reqs.length) return null;
  const held: any[] = await tenantDb.query(
    "SELECT skill_id, level, certified_on, valid_until FROM spa_therapist_skills WHERE therapist_id = ?", [therapistId]).catch(() => []);
  const gaps: string[] = [];
  for (const r of reqs) {
    const h = held.find((x: any) => String(x.skill_id) === String(r.skill_id));
    const need = String(r.min_level || "QUALIFIED").toUpperCase();
    if (!h) { gaps.push(`No ${r.name}`); continue; }
    if (spaLevelRank(h.level) < spaLevelRank(need)) gaps.push(`${r.name} at ${String(h.level || "").toLowerCase()} level — needs ${need.toLowerCase()}`);
    if (h.valid_until && String(h.valid_until).slice(0, 10) < date) gaps.push(`${r.name} certificate expired ${String(h.valid_until).slice(0, 10)}`);
    else if (Number(r.requires_certification) === 1 && !h.certified_on) gaps.push(`${r.name} needs a certificate on file`);
  }
  return gaps;
}

/** Treatments a therapist leads or assists on, on a date (cancelled and no-shows
 *  aside), leaving one appointment out when asked. */
export async function spaTherapistDayCount(tenantDb: DbInterface, therapistId: string, date: string, excludeApptId?: string): Promise<number> {
  const dayStart = `${date} 00:00:00`, dayEnd = tsShift(`${date} 00:00:00`, 1440);
  const tail = excludeApptId ? "AND a.id <> ?" : "";
  const n: any = await tenantDb.get(
    `SELECT COUNT(*) AS n FROM spa_appointments a
      WHERE (a.therapist_id = ? OR EXISTS (SELECT 1 FROM spa_appointment_therapists x WHERE x.appointment_id = a.id AND x.therapist_id = ?))
        AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.start_at >= ? AND a.start_at < ? ${tail}`,
    excludeApptId ? [therapistId, therapistId, dayStart, dayEnd, excludeApptId] : [therapistId, therapistId, dayStart, dayEnd]
  ).catch(() => tenantDb.get(
    `SELECT COUNT(*) AS n FROM spa_appointments a
      WHERE a.therapist_id = ? AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.start_at >= ? AND a.start_at < ? ${tail}`,
    excludeApptId ? [therapistId, dayStart, dayEnd, excludeApptId] : [therapistId, dayStart, dayEnd]));
  return Number(n?.n || 0);
}

export interface SpaAssignmentProblem { code: string; message: string }

/** The rules the slot engine applies, checked for a therapist and cabin chosen
 *  by hand: the skills the service needs, the same-gender rule, the guest's
 *  therapist preference, the therapist's daily limit, the cabin type and a cabin
 *  kept for one gender. Busy and blocked time are checked by the window checks.
 *  A service that names no skills is not held to the therapist-to-service
 *  mapping here, as before. */
export async function spaAssignmentProblems(
  tenantDb: DbInterface,
  o: { service: any; therapistId: string | null; resourceId: string | null; date: string; guestGender: string | null; preference: string | null; excludeApptId?: string }
): Promise<SpaAssignmentProblem[]> {
  const out: SpaAssignmentProblem[] = [];
  const guest = spaGenderCode(o.guestGender);
  const pref = spaGenderCode(o.preference);
  const sameGender = String(o.service?.gender_rule || "ANY").toUpperCase() === "SAME_GENDER";
  if (o.therapistId) {
    const t: any = await tenantDb.get("SELECT id, display_name, gender, max_treatments_per_day FROM spa_therapists WHERE id = ?", [o.therapistId]);
    const name = t?.display_name || "This therapist";
    const gaps = await spaSkillGaps(tenantDb, o.service.id, o.therapistId, o.date);
    if (gaps && gaps.length) out.push({ code: "THERAPIST_NOT_QUALIFIED", message: `${name} cannot give this treatment: ${gaps.join("; ")}.` });
    if (sameGender) {
      if (!guest) out.push({ code: "GUEST_GENDER_REQUIRED", message: "This treatment is given by a therapist of the guest's gender — record the guest's gender." });
      else if (spaGenderCode(t?.gender) !== guest) out.push({ code: "GENDER_RULE", message: `This treatment needs a ${guest.toLowerCase()} therapist.` });
    }
    if (pref && spaGenderCode(t?.gender) !== pref) out.push({ code: "PREFERENCE_MISMATCH", message: `The guest asked for a ${pref.toLowerCase()} therapist.` });
    const cap = Number(t?.max_treatments_per_day || 0);
    if (cap > 0) {
      const count = await spaTherapistDayCount(tenantDb, o.therapistId, o.date, o.excludeApptId);
      if (count >= cap) out.push({ code: "DAILY_LIMIT", message: `${name} already has ${count} treatment(s) that day — the limit is ${cap}.` });
    }
  }
  if (o.resourceId) {
    const r: any = await tenantDb.get(
      `SELECT r.name, r.cabin_type_id, r.gender_designation, ct.name AS type_name
         FROM spa_resources r LEFT JOIN spa_cabin_types ct ON ct.id = r.cabin_type_id WHERE r.id = ?`, [o.resourceId]);
    if (r && o.service?.cabin_type_id && r.cabin_type_id !== o.service.cabin_type_id) {
      const want: any = await tenantDb.get("SELECT name FROM spa_cabin_types WHERE id = ?", [o.service.cabin_type_id]).catch(() => null);
      out.push({ code: "CABIN_TYPE", message: `This treatment needs a cabin of type ${want?.name || "set on the treatment"}; ${r.name} is ${r.type_name ? `of type ${r.type_name}` : "not given a type"}.` });
    }
    const g = spaGenderCode(r?.gender_designation);
    if (r && g) {
      if (!guest) {
        if (!out.some(p => p.code === "GUEST_GENDER_REQUIRED")) out.push({ code: "GUEST_GENDER_REQUIRED", message: `${r.name} is kept for ${g.toLowerCase()} guests — record the guest's gender.` });
      } else if (g !== guest) {
        out.push({ code: "CABIN_GENDER", message: `${r.name} is kept for ${g.toLowerCase()} guests.` });
      }
    }
  }
  return out;
}

/** Whether a booking of these slots needs the guest's gender: the service is
 *  same-gender, or a slot's cabin is kept for one gender. */
export async function spaNeedsGuestGender(tenantDb: DbInterface, serviceId: string, slots: SpaSlot[]): Promise<boolean> {
  if (slots.some(s => !!s.resource_gender)) return true;
  const svc: any = await tenantDb.get("SELECT gender_rule FROM spa_services WHERE id = ?", [serviceId]).catch(() => null);
  return String(svc?.gender_rule || "ANY").toUpperCase() === "SAME_GENDER";
}

/** Returns a manual block (THERAPIST or RESOURCE) overlapping the window, or null. */
export async function blockConflict(
  tenantDb: DbInterface, scope: "THERAPIST" | "RESOURCE", scopeId: string, startAt: string, endAt: string
): Promise<any | null> {
  const rows = await tenantDb.query(
    `SELECT id, reason FROM spa_resource_blocks
      WHERE scope = ? AND scope_id = ?
        AND start_at < ? AND end_at > ?
      LIMIT 1`,
    [scope, scopeId, endAt, startAt]
  );
  return rows[0] || null;
}

// ── Appointment lifecycle ──────────────────────────────────────────────────
// The moves an appointment may make. The routes used to set whatever status they
// were asked for: a booked guest who never arrived could be completed, and a
// guest already checked in could be marked a no-show.
export const SPA_TRANSITIONS: Record<string, string[]> = {
  BOOKED:      ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CONFIRMED:   ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN:  ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED:   [],
  CANCELLED:   [],
  NO_SHOW:     [],
};

/** Why an appointment cannot move from `from` to `to`, or null if it can. A move
 *  to the status it already has is not an error; callers treat it as done. */
export function spaTransitionError(fromRaw: string, to: string): string | null {
  const from = String(fromRaw || "BOOKED").toUpperCase();
  if (from === to) return null;
  if ((SPA_TRANSITIONS[from] || []).includes(to)) return null;
  const word: Record<string, string> = {
    BOOKED: "booked", CONFIRMED: "confirmed", CHECKED_IN: "checked in", IN_PROGRESS: "in progress",
    COMPLETED: "completed", CANCELLED: "cancelled", NO_SHOW: "marked a no-show",
  };
  const w = (s: string) => word[s] || s.toLowerCase();
  if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(from)) return `This appointment is already ${w(from)}.`;
  if (to === "COMPLETED") return "Check the guest in before completing the treatment.";
  if (to === "IN_PROGRESS") return "Check the guest in before starting the treatment.";
  if (to === "NO_SHOW") return "The guest has already checked in, so this cannot be a no-show.";
  if (to === "CANCELLED") return "A treatment in progress cannot be cancelled. Complete it instead.";
  return `This appointment is ${w(from)}, so it cannot be ${w(to)}.`;
}

/** Two bookings written at the same moment can both pass the conflict checks:
 *  the database layer has no transaction across statements. Call this after
 *  writing an appointment. If another live appointment for the same therapist
 *  or cabin overlaps it and was created earlier (ties broken by id), this one
 *  must give way. Both sides reach the same answer, so exactly one survives. */
export async function spaMustYield(tenantDb: DbInterface, apptId: string): Promise<boolean> {
  // The two share the cabin, or a therapist — leading or assisting on either.
  const shared = await tenantDb.get(
    `SELECT o.id FROM spa_appointments o, spa_appointments me
      WHERE me.id = ? AND o.id <> me.id
        AND o.status NOT IN ('CANCELLED','NO_SHOW')
        AND o.start_at < me.end_at AND o.end_at > me.start_at
        AND ((me.resource_id IS NOT NULL AND o.resource_id = me.resource_id)
          OR (me.therapist_id IS NOT NULL AND (o.therapist_id = me.therapist_id
                OR EXISTS (SELECT 1 FROM spa_appointment_therapists y WHERE y.appointment_id = o.id AND y.therapist_id = me.therapist_id)))
          OR EXISTS (SELECT 1 FROM spa_appointment_therapists x WHERE x.appointment_id = me.id
                AND (x.therapist_id = o.therapist_id
                  OR EXISTS (SELECT 1 FROM spa_appointment_therapists y WHERE y.appointment_id = o.id AND y.therapist_id = x.therapist_id))))
        AND (o.created_at < me.created_at OR (o.created_at = me.created_at AND o.id < me.id))
      LIMIT 1`,
    [apptId]
  ).then((r: any) => ({ ok: true, row: r })).catch(() => ({ ok: false, row: null }));
  if (shared.ok) return !!shared.row;
  const row = await tenantDb.get(
    `SELECT o.id FROM spa_appointments o, spa_appointments me
      WHERE me.id = ? AND o.id <> me.id
        AND o.status NOT IN ('CANCELLED','NO_SHOW')
        AND o.start_at < me.end_at AND o.end_at > me.start_at
        AND ((me.therapist_id IS NOT NULL AND o.therapist_id = me.therapist_id)
          OR (me.resource_id IS NOT NULL AND o.resource_id = me.resource_id))
        AND (o.created_at < me.created_at OR (o.created_at = me.created_at AND o.id < me.id))
      LIMIT 1`,
    [apptId]
  );
  return !!row;
}

// ── Dual-resource availability slot engine ─────────────────────────────────
// For a service + date (+ optional therapist filter), returns bookable slots,
// each carrying BOTH a free therapist and a free resource. Granularity = 30m.

export interface SpaSlot {
  start_at: string;
  end_at: string;
  therapist_id: string;
  therapist_name: string;
  resource_id: string | null;
  resource_name: string | null;
  /** FEMALE or MALE when the chosen cabin is kept for one gender. */
  resource_gender?: string | null;
  /** The other therapists, for a treatment given by more than one. */
  assistant_ids?: string[];
  assistant_names?: string[];
}

export async function findAvailableSlots(
  tenantDb: DbInterface,
  opts: { serviceId: string; date: string; therapistId?: string; granularityMin?: number; maxSlots?: number; guestGender?: string | null; therapistGender?: string | null }
): Promise<SpaSlot[]> {
  const granularity = opts.granularityMin || 30;
  const maxSlots = opts.maxSlots || 60;

  const service: any = await tenantDb.get(
    "SELECT * FROM spa_services WHERE id = ? AND is_active = 1", [opts.serviceId]
  );
  if (!service) return [];
  const window = serviceWindowMinutes(service);
  const needRoom = Number(service.requires_room ?? 1) === 1;
  const needTherapist = Number(service.requires_therapist ?? 1) === 1;
  const dow = dowOf(opts.date);
  const date = opts.date;
  const guestGender = spaGenderCode(opts.guestGender);
  const preference = spaGenderCode(opts.therapistGender);
  // How many therapists give it together: the lead and those assisting.
  const required = needTherapist ? Math.max(1, Math.min(4, Number(service.therapists_required || 1))) : 1;

  // Therapists rostered that weekday, inside the shift's effective dates, with
  // any break in it — all of them, so a treatment for more than one therapist
  // can find the others when one therapist's slots are asked for.
  let therapists: any[] = await tenantDb.query(
    `SELECT t.id, t.display_name, t.gender, t.max_treatments_per_day, s.start_time, s.end_time, s.break_start, s.break_end
       FROM spa_therapists t
       JOIN spa_therapist_schedules s ON s.therapist_id = t.id AND s.weekday = ?
      WHERE t.is_active = 1
        AND (s.effective_from IS NULL OR s.effective_from = '' OR s.effective_from <= ?)
        AND (s.effective_to IS NULL OR s.effective_to = '' OR s.effective_to >= ?)
      ORDER BY t.display_name, s.start_time`,
    [dow, date, date]
  );
  // Who may deliver it: the skills the service names, at their level and in
  // date; a service that names no skills keeps the older therapist-to-service
  // mapping. (A service needing no therapist still gets one lane per rostered
  // therapist, so the slot always carries an operator.)
  if (needTherapist) {
    const qualified = await spaQualifiedTherapistIds(tenantDb, service.id, date);
    if (qualified) {
      therapists = therapists.filter((t: any) => qualified.has(String(t.id)));
    } else {
      const mapped: any[] = await tenantDb.query("SELECT therapist_id FROM spa_therapist_services WHERE service_id = ?", [service.id]).catch(() => []);
      const mappedIds = new Set(mapped.map((m: any) => String(m.therapist_id)));
      therapists = therapists.filter((t: any) => mappedIds.has(String(t.id)));
    }
  }
  // A same-gender therapy once the guest's gender is known, and the guest's own
  // preference. A therapist whose gender is not recorded matches neither.
  if (guestGender && String(service.gender_rule || "ANY").toUpperCase() === "SAME_GENDER") {
    therapists = therapists.filter((t: any) => spaGenderCode(t.gender) === guestGender);
  }
  if (preference) therapists = therapists.filter((t: any) => spaGenderCode(t.gender) === preference);
  // The therapists slots are led by: the one asked for, or every one.
  const leads = opts.therapistId ? therapists.filter((t: any) => String(t.id) === String(opts.therapistId)) : therapists;

  // Cabins: active, not under maintenance or out of order, of the type the
  // service needs when it names one, and not kept for the other gender. A cabin
  // open to everyone is chosen before one kept for a gender.
  const resources: any[] = needRoom
    ? (await tenantDb.query(
        `SELECT id, name, COALESCE(turnaround_min, 0) AS turnaround_min, gender_designation FROM spa_resources
          WHERE is_active = 1 AND COALESCE(status, 'AVAILABLE') NOT IN ('MAINTENANCE', 'OUT_OF_ORDER')
            ${service.cabin_type_id ? "AND cabin_type_id = ?" : ""}
          ORDER BY name`,
        service.cabin_type_id ? [service.cabin_type_id] : []) as any[])
        .filter((r: any) => { const g = spaGenderCode(r.gender_designation); return !g || !guestGender || g === guestGender; })
        .sort((a: any, b: any) => (spaGenderCode(a.gender_designation) ? 1 : 0) - (spaGenderCode(b.gender_designation) ? 1 : 0))
    : [];

  // The day's bookings and blocks, read once — with four hours either side for a
  // cabin's turnaround — and compared as 'YYYY-MM-DD HH:MM:SS' text. The engine
  // ran a query for every therapist, cabin and slot.
  const loadFrom = tsShift(`${date} 00:00:00`, -240);
  const loadTo = tsShift(`${date} 00:00:00`, 1440 + 240);
  const booked: any[] = await tenantDb.query(
    `SELECT therapist_id, resource_id, to_char(start_at, 'YYYY-MM-DD HH24:MI:SS') AS s, to_char(end_at, 'YYYY-MM-DD HH24:MI:SS') AS e
       FROM spa_appointments
      WHERE status NOT IN ('CANCELLED','NO_SHOW') AND start_at < ? AND end_at > ?`, [loadTo, loadFrom]);
  // Assisting on a treatment takes a therapist's time as leading one does.
  const assisting: any[] = await tenantDb.query(
    `SELECT x.therapist_id, to_char(a.start_at, 'YYYY-MM-DD HH24:MI:SS') AS s, to_char(a.end_at, 'YYYY-MM-DD HH24:MI:SS') AS e
       FROM spa_appointment_therapists x JOIN spa_appointments a ON a.id = x.appointment_id
      WHERE a.status NOT IN ('CANCELLED','NO_SHOW') AND a.start_at < ? AND a.end_at > ?`, [loadTo, loadFrom]).catch(() => []);
  for (const x of assisting) booked.push({ therapist_id: x.therapist_id, resource_id: null, s: x.s, e: x.e });
  const blocks: any[] = await tenantDb.query(
    `SELECT scope, scope_id, to_char(start_at, 'YYYY-MM-DD HH24:MI:SS') AS s, to_char(end_at, 'YYYY-MM-DD HH24:MI:SS') AS e
       FROM spa_resource_blocks WHERE start_at < ? AND end_at > ?`, [loadTo, loadFrom]);
  const overlaps = (s: string, e: string, from: string, to: string) => s < to && e > from;
  // Treatments each therapist already has that day, for the daily limit.
  const dayCount = new Map<string, number>();
  for (const bk of booked) {
    if (bk.therapist_id && String(bk.s).slice(0, 10) === date) dayCount.set(String(bk.therapist_id), (dayCount.get(String(bk.therapist_id)) || 0) + 1);
  }
  // A shift row covers a window, clear of its break.
  const covers = (row: any, startMin: number, endMin: number) => {
    const from = hhmmToMinutes(row.start_time), to = hhmmToMinutes(row.end_time);
    if (!(from <= startMin && endMin <= to)) return false;
    const bs = row.break_start ? hhmmToMinutes(row.break_start) : null;
    const be = row.break_end ? hhmmToMinutes(row.break_end) : null;
    return !(bs != null && be != null && be > bs && startMin < be && endMin > bs);
  };
  const underCap = (row: any) => {
    const cap = Number(row.max_treatments_per_day || 0);
    return !(cap > 0 && (dayCount.get(String(row.id)) || 0) >= cap);
  };
  const freeAt = (therapistId: any, startAt: string, endAt: string) =>
    !booked.some(bk => bk.therapist_id === therapistId && overlaps(bk.s, bk.e, startAt, endAt))
    && !blocks.some(k => k.scope === "THERAPIST" && k.scope_id === therapistId && overlaps(k.s, k.e, startAt, endAt));

  const slots: SpaSlot[] = [];
  for (const t of leads) {
    if (!underCap(t)) continue;
    const schedStart = hhmmToMinutes(t.start_time);
    const schedEnd = hhmmToMinutes(t.end_time);
    for (let startMin = schedStart; startMin + window <= schedEnd; startMin += granularity) {
      if (slots.length >= maxSlots) return slots;
      const endMin = startMin + window;
      // Nothing is booked across the therapist's break.
      if (!covers(t, startMin, endMin)) continue;
      const startAt = tsFromDateMinutes(opts.date, startMin);
      const endAt = tsFromDateMinutes(opts.date, endMin);

      // therapist free?
      if (!freeAt(t.id, startAt, endAt)) continue;

      // A treatment for more than one therapist needs the others free then too.
      const assistants: any[] = [];
      if (required > 1) {
        const taken = new Set<string>([String(t.id)]);
        for (const o of therapists) {
          if (assistants.length >= required - 1) break;
          if (taken.has(String(o.id)) || !covers(o, startMin, endMin) || !underCap(o) || !freeAt(o.id, startAt, endAt)) continue;
          taken.add(String(o.id));
          assistants.push(o);
        }
        if (assistants.length < required - 1) continue;
      }

      // resource free? (first available cabin, turnaround included)
      let chosenResource: any = null;
      if (needRoom) {
        for (const r of resources) {
          const turn = Math.max(0, Number(r.turnaround_min || 0));
          const clearFrom = turn ? tsShift(startAt, -turn) : startAt;
          const clearTo = turn ? tsShift(endAt, turn) : endAt;
          if (booked.some(bk => bk.resource_id === r.id && overlaps(bk.s, bk.e, clearFrom, clearTo))) continue;
          if (blocks.some(k => k.scope === "RESOURCE" && k.scope_id === r.id && overlaps(k.s, k.e, startAt, endAt))) continue;
          chosenResource = r;
          break;
        }
        if (!chosenResource) continue; // no free cabin for this slot
      }

      slots.push({
        start_at: startAt,
        end_at: endAt,
        therapist_id: t.id,
        therapist_name: t.display_name,
        resource_id: chosenResource ? chosenResource.id : null,
        resource_name: chosenResource ? chosenResource.name : null,
        resource_gender: chosenResource ? spaGenderCode(chosenResource.gender_designation) : null,
        ...(assistants.length ? { assistant_ids: assistants.map((a: any) => a.id), assistant_names: assistants.map((a: any) => a.display_name) } : {}),
      });
    }
  }
  return slots;
}

// ════════════════════════════════════════════════════════════════════════
// Schema — idempotent. Safe to call repeatedly. Every ALTER wrapped in
// .catch(() => {}) so one transient failure can't poison the cached DbInterface.
// ════════════════════════════════════════════════════════════════════════

export async function createSpaTables(tenantDb: DbInterface): Promise<void> {
  // ── Folio ledger (reused from Hotel). Self-create for spa-only tenants
  // (property_type='RESTAURANT') that never ran createHotelTables. IF NOT
  // EXISTS → no-op when hotel already created them. Schema matches the hotel
  // definition in server.ts; the two spa columns are added via ALTER below.
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS folios (
      id              TEXT PRIMARY KEY,
      booking_id      TEXT,
      room_id         TEXT,
      status          TEXT DEFAULT 'open',
      subtotal        DOUBLE PRECISION DEFAULT 0,
      gst_amount      DOUBLE PRECISION DEFAULT 0,
      service_charge  DOUBLE PRECISION DEFAULT 0,
      discount        DOUBLE PRECISION DEFAULT 0,
      grand_total     DOUBLE PRECISION DEFAULT 0,
      payment_method  TEXT,
      settled_at      TIMESTAMP,
      doc_type        TEXT DEFAULT 'INVOICE',
      parent_folio_id TEXT,
      reason          TEXT,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS folio_entries (
      id         TEXT PRIMARY KEY,
      folio_id   TEXT,
      entry_type TEXT,
      description TEXT,
      quantity   INT DEFAULT 1,
      unit_price DOUBLE PRECISION,
      amount     DOUBLE PRECISION,
      gst_rate   DOUBLE PRECISION,
      gst_amount DOUBLE PRECISION,
      source_id  TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS folio_payments (
      id               TEXT PRIMARY KEY,
      folio_id         TEXT NOT NULL,
      amount           DOUBLE PRECISION NOT NULL,
      payment_method   TEXT NOT NULL,
      payment_type     TEXT NOT NULL DEFAULT 'INTERIM',
      reference_number TEXT,
      recorded_by      TEXT,
      recorded_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes            TEXT,
      is_voided        INT DEFAULT 0,
      voided_at        TIMESTAMP,
      voided_by        TEXT,
      voided_reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_folio_entries_folio ON folio_entries(folio_id);
    CREATE INDEX IF NOT EXISTS idx_folio_payments_folio ON folio_payments(folio_id, recorded_at);
  `);
  // Folio columns that the hotel block also adds (idempotent — needed for the
  // spa-only-tenant path where the hotel block never ran).
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS currency_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS tax_label_snapshot TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt INTEGER DEFAULT 0`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS gst_exempt_reason TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS folio_kind TEXT DEFAULT 'HOTEL'`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS appointment_id TEXT`).catch(() => {});
  // Buyer GST details on the folio itself. Hotel and event folios already resolve
  // a GSTIN from their booking; a SPA folio has no booking to carry one, so this
  // is where a spa client's GSTIN lives — and it also lets any folio override its
  // booking's GSTIN for the one invoice that needs it.
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS customer_gstin TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS customer_address TEXT`).catch(() => {});
  // Links an advance receipt to its Rule 50 receipt voucher.
  await tenantDb.exec(`ALTER TABLE folio_payments ADD COLUMN IF NOT EXISTS receipt_voucher_id TEXT`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE folio_payments ADD COLUMN IF NOT EXISTS refund_voucher_id TEXT`).catch(() => {});
  // Spa folios carry their own invoice number (SPA-<year>-NNNNN). Hotel folios
  // derive the number from the folio id at render time and leave this NULL.
  await tenantDb.exec(`ALTER TABLE folios ADD COLUMN IF NOT EXISTS invoice_number TEXT`).catch(() => {});

  // ── Catalog ──────────────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_services (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      category           TEXT DEFAULT 'MASSAGE',
      description        TEXT,
      duration_min       INT NOT NULL DEFAULT 60,
      buffer_before_min  INT DEFAULT 0,
      buffer_after_min   INT DEFAULT 10,
      price              DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent        DOUBLE PRECISION DEFAULT 18,
      requires_room      INT DEFAULT 1,
      requires_therapist INT DEFAULT 1,
      commission_pct     DOUBLE PRECISION DEFAULT 0,
      image_url          TEXT,
      display_order      INT DEFAULT 0,
      is_active          INT DEFAULT 1,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_services_category ON spa_services(category);

    CREATE TABLE IF NOT EXISTS spa_service_addons (
      id                TEXT PRIMARY KEY,
      service_id        TEXT NOT NULL,
      name              TEXT NOT NULL,
      extra_duration_min INT DEFAULT 0,
      extra_price       DOUBLE PRECISION DEFAULT 0,
      gst_percent       DOUBLE PRECISION DEFAULT 18,
      is_active         INT DEFAULT 1,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_addons_service ON spa_service_addons(service_id);

    -- Supply-chain bridge: which inventory items a service consumes per delivery.
    -- ingredient_id → ingredients (item_type='SPA_PRODUCT'); completing the
    -- appointment writes a negative stock_movement, the same audit log the
    -- restaurant/hotel inventory uses.
    CREATE TABLE IF NOT EXISTS spa_service_consumables (
      id            TEXT PRIMARY KEY,
      service_id    TEXT NOT NULL,
      ingredient_id TEXT NOT NULL,
      qty_per_service DOUBLE PRECISION NOT NULL DEFAULT 0,
      unit          TEXT,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_consumables_service ON spa_service_consumables(service_id);
  `);

  // ── Dual-resource scheduling ───────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_resources (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      resource_type TEXT DEFAULT 'CABIN',
      capacity      INT DEFAULT 1,
      notes         TEXT,
      is_active     INT DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Thin therapist profile referencing the shared staff directory so
    -- commissions/payroll stay in attendance_staff. staff_id is optional
    -- (a therapist may exist before being added as a login/offline staff).
    CREATE TABLE IF NOT EXISTS spa_therapists (
      id                   TEXT PRIMARY KEY,
      staff_id             TEXT,
      display_name         TEXT NOT NULL,
      bio                  TEXT,
      commission_pct_override DOUBLE PRECISION,
      is_active            INT DEFAULT 1,
      created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_therapist_services (
      id           TEXT PRIMARY KEY,
      therapist_id TEXT NOT NULL,
      service_id   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_ther_svc_unique ON spa_therapist_services(therapist_id, service_id);

    CREATE TABLE IF NOT EXISTS spa_therapist_schedules (
      id             TEXT PRIMARY KEY,
      therapist_id   TEXT NOT NULL,
      weekday        INT NOT NULL,            -- 0=Sun … 6=Sat
      start_time     TEXT NOT NULL,           -- 'HH:MM'
      end_time       TEXT NOT NULL,           -- 'HH:MM'
      effective_from TEXT,
      effective_to   TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_sched_ther ON spa_therapist_schedules(therapist_id, weekday);

    CREATE TABLE IF NOT EXISTS spa_resource_blocks (
      id         TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,               -- THERAPIST | RESOURCE
      scope_id   TEXT NOT NULL,
      start_at   TIMESTAMP NOT NULL,
      end_at     TIMESTAMP NOT NULL,
      reason     TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_blocks_scope ON spa_resource_blocks(scope, scope_id);
  `);

  // ── Client CRM + forms (med-spa-ready) ─────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_clients (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      phone            TEXT,
      email            TEXT,
      gender           TEXT,
      dob              TEXT,
      preferences      TEXT,
      tags             TEXT,
      marketing_opt_in INT DEFAULT 0,
      linked_guest_phone TEXT,
      notes            TEXT,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_clients_phone ON spa_clients(phone);

    CREATE TABLE IF NOT EXISTS spa_client_intake_forms (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      appointment_id TEXT,
      form_type     TEXT DEFAULT 'INTAKE',     -- INTAKE | CONSENT | (med-spa: MEDICAL_HISTORY | MEDICAL_CONSENT)
      responses     TEXT,                      -- JSON
      signature_url TEXT,
      signed_at     TIMESTAMP,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_forms_client ON spa_client_intake_forms(client_id);

    -- Med-spa-ready clinical stubs — created now, NOT written by day-spa flows.
    -- Having the tables means the clinical layer is purely additive later (no
    -- ALTER on a large table, FK targets already exist).
    CREATE TABLE IF NOT EXISTS spa_clinical_notes (
      id               TEXT PRIMARY KEY,
      client_id        TEXT NOT NULL,
      appointment_id   TEXT,
      soap_subjective  TEXT,
      soap_objective   TEXT,
      soap_assessment  TEXT,
      soap_plan        TEXT,
      provider_id      TEXT,
      locked_at        TIMESTAMP,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS spa_client_photos (
      id             TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      appointment_id TEXT,
      photo_url      TEXT,
      photo_kind     TEXT,                     -- BEFORE | AFTER | PROGRESS
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Appointments ───────────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_appointments (
      id              TEXT PRIMARY KEY,
      client_id       TEXT,
      client_name     TEXT,
      client_phone    TEXT,
      client_email    TEXT,
      service_id      TEXT NOT NULL,
      service_name    TEXT,
      addon_ids       TEXT,                    -- JSON array
      therapist_id    TEXT,
      resource_id     TEXT,
      start_at        TIMESTAMP NOT NULL,
      end_at          TIMESTAMP NOT NULL,
      status          TEXT DEFAULT 'BOOKED',   -- BOOKED|CONFIRMED|CHECKED_IN|IN_PROGRESS|COMPLETED|CANCELLED|NO_SHOW
      price_snapshot  DOUBLE PRECISION DEFAULT 0,
      gst_snapshot    DOUBLE PRECISION DEFAULT 0,
      gst_percent_snapshot DOUBLE PRECISION DEFAULT 0,
      deposit_amount  DOUBLE PRECISION DEFAULT 0,
      booking_source  TEXT DEFAULT 'STAFF',    -- STAFF | ONLINE
      intake_form_id  TEXT,
      package_redemption_id TEXT,
      membership_id   TEXT,
      folio_id        TEXT,
      notes           TEXT,
      cancelled_at    TIMESTAMP,
      cancellation_reason TEXT,
      no_show_at      TIMESTAMP,
      completed_at    TIMESTAMP,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_appt_therapist_time ON spa_appointments(therapist_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_resource_time ON spa_appointments(resource_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_status ON spa_appointments(status);
    CREATE INDEX IF NOT EXISTS idx_spa_appt_client ON spa_appointments(client_id);
  `);
  // Added Sep 2026 with the spa guest notifications: an appointment could only
  // ever carry a phone number, so a client could not be emailed. Existing rows
  // still resolve through spa_clients.email where the client is on file.
  await tenantDb.exec(`ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS client_email TEXT`).catch(() => {});
  // When the guest was checked in and when the treatment actually started. The
  // booking kept only the scheduled times and a completion time.
  await tenantDb.exec(`ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP`).catch(() => {});
  await tenantDb.exec(`ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`).catch(() => {});
  // One consumption line per appointment and item, so a completion retried after
  // a failure, or two completions at once, can never draw the same stock twice.
  await tenantDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_consumption_once ON stock_movements (reference_id, ingredient_id) WHERE movement_type = 'SPA_CONSUMPTION' AND reference_type = 'spa_appointment'`).catch(() => {});

  // ── Phase 1 (Sep 2026): skills, cabin types, therapist profiles, rosters ────
  // A therapist's "skills" were only the list of services they could deliver.
  // Skills are now their own master, held at a level with certification dates,
  // and a service names the skills (and minimum level) it needs.
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_skills (
      id                     TEXT PRIMARY KEY,
      code                   TEXT NOT NULL,
      name                   TEXT NOT NULL,
      category               TEXT,
      requires_certification INT DEFAULT 0,
      is_active              INT DEFAULT 1,
      created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_skills_code ON spa_skills(code);
    CREATE TABLE IF NOT EXISTS spa_therapist_skills (
      id           TEXT PRIMARY KEY,
      therapist_id TEXT NOT NULL,
      skill_id     TEXT NOT NULL,
      level        TEXT DEFAULT 'QUALIFIED',
      certified_on TEXT,
      valid_until  TEXT,
      notes        TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_therapist_skill ON spa_therapist_skills(therapist_id, skill_id);
    CREATE TABLE IF NOT EXISTS spa_service_skills (
      id         TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      skill_id   TEXT NOT NULL,
      min_level  TEXT DEFAULT 'QUALIFIED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_service_skill ON spa_service_skills(service_id, skill_id);
    CREATE TABLE IF NOT EXISTS spa_cabin_types (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      is_active   INT DEFAULT 1,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_cabin_types_code ON spa_cabin_types(code);
  `);
  for (const ddl of [
    `ALTER TABLE spa_therapists ADD COLUMN IF NOT EXISTS gender TEXT`,
    `ALTER TABLE spa_therapists ADD COLUMN IF NOT EXISTS languages TEXT`,
    `ALTER TABLE spa_therapists ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE spa_therapists ADD COLUMN IF NOT EXISTS photo_url TEXT`,
    `ALTER TABLE spa_therapists ADD COLUMN IF NOT EXISTS max_treatments_per_day INT`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS cabin_type_id TEXT`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS equipment TEXT`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS gender_designation TEXT DEFAULT 'ANY'`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS turnaround_min INT DEFAULT 0`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'AVAILABLE'`,
    `ALTER TABLE spa_resources ADD COLUMN IF NOT EXISTS status_reason TEXT`,
    `ALTER TABLE spa_services ADD COLUMN IF NOT EXISTS cabin_type_id TEXT`,
    `ALTER TABLE spa_services ADD COLUMN IF NOT EXISTS gender_rule TEXT DEFAULT 'ANY'`,
    `ALTER TABLE spa_therapist_schedules ADD COLUMN IF NOT EXISTS break_start TEXT`,
    `ALTER TABLE spa_therapist_schedules ADD COLUMN IF NOT EXISTS break_end TEXT`,
    // Phase 2: the guest's gender and therapist preference as booked, and why a
    // booking was made outside the rules.
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS client_gender TEXT`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS therapist_gender_pref TEXT`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS assignment_override_reason TEXT`,
    // Phase 2b: a treatment given by more than one therapist — the lead stays on
    // the appointment, those assisting are listed here.
    `ALTER TABLE spa_services ADD COLUMN IF NOT EXISTS therapists_required INT DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS spa_appointment_therapists (
      id             TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      therapist_id   TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_appt_therapist ON spa_appointment_therapists(appointment_id, therapist_id)`,
    `CREATE INDEX IF NOT EXISTS idx_spa_appt_therapist_t ON spa_appointment_therapists(therapist_id)`,
    // Phase 3: what happened in a treatment — the actual times, who performed it,
    // the cabin used, notes and follow-up — and what it used against its standard,
    // batch by batch. An add-on can carry consumables; an item can vary per treatment.
    `ALTER TABLE spa_service_consumables ADD COLUMN IF NOT EXISTS addon_id TEXT`,
    `ALTER TABLE spa_service_consumables ADD COLUMN IF NOT EXISTS is_variable INT DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS spa_treatment_sessions (
      id             TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      started_at     TIMESTAMP,
      finished_at    TIMESTAMP,
      resource_id    TEXT,
      notes          TEXT,
      outcome        TEXT,
      follow_up      TEXT,
      follow_up_date TEXT,
      recorded_by    TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_session_appt ON spa_treatment_sessions(appointment_id)`,
    `CREATE TABLE IF NOT EXISTS spa_session_therapists (
      id             TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      therapist_id   TEXT NOT NULL,
      role           TEXT DEFAULT 'LEAD',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_session_therapist ON spa_session_therapists(appointment_id, therapist_id)`,
    `CREATE INDEX IF NOT EXISTS idx_spa_session_therapist_t ON spa_session_therapists(therapist_id)`,
    `CREATE TABLE IF NOT EXISTS spa_session_consumables (
      id             TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      ingredient_id  TEXT NOT NULL,
      standard_qty   DOUBLE PRECISION DEFAULT 0,
      actual_qty     DOUBLE PRECISION DEFAULT 0,
      unit           TEXT,
      unit_cost      DOUBLE PRECISION,
      movement_id    TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_spa_session_item ON spa_session_consumables(appointment_id, ingredient_id)`,
    `CREATE TABLE IF NOT EXISTS spa_consumption_batches (
      id             TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      ingredient_id  TEXT NOT NULL,
      batch_id       TEXT,
      qty            DOUBLE PRECISION NOT NULL,
      unit_cost      DOUBLE PRECISION,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_cons_batch ON spa_consumption_batches(batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_spa_cons_appt ON spa_consumption_batches(appointment_id)`,
    `CREATE TABLE IF NOT EXISTS spa_tip_splits (
      id             TEXT PRIMARY KEY,
      folio_id       TEXT NOT NULL,
      appointment_id TEXT,
      therapist_id   TEXT NOT NULL,
      amount         DOUBLE PRECISION NOT NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_tip_splits_t ON spa_tip_splits(therapist_id)`,
    `CREATE INDEX IF NOT EXISTS idx_spa_tip_splits_appt ON spa_tip_splits(appointment_id)`,
    // Phase 4: the guest's health record and course of care, for clinical staff,
    // with every read logged; consent and intake before check-in; purchases linked
    // to the guest.
    `ALTER TABLE spa_services ADD COLUMN IF NOT EXISTS requires_consent INT DEFAULT 0`,
    `ALTER TABLE spa_services ADD COLUMN IF NOT EXISTS contraindications TEXT`,
    `ALTER TABLE spa_client_intake_forms ADD COLUMN IF NOT EXISTS signed_by_name TEXT`,
    `ALTER TABLE spa_client_intake_forms ADD COLUMN IF NOT EXISTS recorded_by TEXT`,
    `ALTER TABLE spa_clinical_notes ADD COLUMN IF NOT EXISTS locked_by TEXT`,
    `ALTER TABLE spa_clinical_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS course_plan_id TEXT`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS clinical_override_reason TEXT`,
    `ALTER TABLE folios ADD COLUMN IF NOT EXISTS spa_client_id TEXT`,
    `CREATE TABLE IF NOT EXISTS spa_client_assessments (
      id           TEXT PRIMARY KEY,
      client_id    TEXT NOT NULL,
      constitution TEXT NOT NULL,
      notes        TEXT,
      assessed_by  TEXT,
      assessed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_assess_client ON spa_client_assessments(client_id)`,
    `CREATE TABLE IF NOT EXISTS spa_course_plans (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      title         TEXT NOT NULL,
      prescribed_by TEXT,
      start_date    TEXT,
      end_date      TEXT,
      status        TEXT DEFAULT 'ACTIVE',
      notes         TEXT,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_plans_client ON spa_course_plans(client_id)`,
    `CREATE TABLE IF NOT EXISTS spa_course_plan_items (
      id                  TEXT PRIMARY KEY,
      plan_id             TEXT NOT NULL,
      service_id          TEXT NOT NULL,
      sessions_prescribed INT NOT NULL,
      frequency_note      TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_plan_items_plan ON spa_course_plan_items(plan_id)`,
    `CREATE TABLE IF NOT EXISTS spa_clinical_access_log (
      id          TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      section     TEXT,
      actor_id    TEXT,
      actor_email TEXT,
      actor_role  TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spa_clin_log_client ON spa_clinical_access_log(client_id, created_at)`,
    // Phase 4b: a treatment for an in-house guest, linked to the stay from go-live
    // and charged to the room bill.
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS room_booking_id TEXT`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS room_folio_id TEXT`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS room_charged_at TIMESTAMP`,
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS room_charge_entry_ids TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_spa_appt_room_booking ON spa_appointments(room_booking_id)`,
    // Booked or moved outside the therapist's roster, and not yet confirmed: why.
    `ALTER TABLE spa_appointments ADD COLUMN IF NOT EXISTS shift_note TEXT`,
  ]) {
    await tenantDb.exec(ddl).catch(() => {});
  }

  // ── Packages (prepaid series, auto-deduct) ─────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_packages (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      service_id     TEXT,                     -- NULL = any service
      total_sessions INT NOT NULL DEFAULT 1,
      price          DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent    DOUBLE PRECISION DEFAULT 18,
      validity_days  INT DEFAULT 365,
      is_active      INT DEFAULT 1,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_client_packages (
      id                TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL,
      package_id        TEXT NOT NULL,
      package_name      TEXT,
      service_id        TEXT,
      sessions_total    INT NOT NULL DEFAULT 0,
      sessions_remaining INT NOT NULL DEFAULT 0,
      price_paid        DOUBLE PRECISION DEFAULT 0,
      expires_at        TIMESTAMP,
      folio_id          TEXT,
      status            TEXT DEFAULT 'ACTIVE', -- ACTIVE | EXPIRED | EXHAUSTED
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_client_pkg_client ON spa_client_packages(client_id, status);

    CREATE TABLE IF NOT EXISTS spa_package_redemptions (
      id                TEXT PRIMARY KEY,
      client_package_id TEXT NOT NULL,
      appointment_id    TEXT,
      sessions_drawn    INT DEFAULT 1,
      redeemed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Memberships (tiered, auto-applied benefits) ────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_membership_plans (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tier          TEXT,
      monthly_fee   DOUBLE PRECISION NOT NULL DEFAULT 0,
      gst_percent   DOUBLE PRECISION DEFAULT 18,
      benefits      TEXT,                      -- JSON {discount_pct, free_services_per_month, included_service_ids}
      is_active     INT DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS spa_client_memberships (
      id                       TEXT PRIMARY KEY,
      client_id                TEXT NOT NULL,
      plan_id                  TEXT NOT NULL,
      plan_name                TEXT,
      benefits_snapshot        TEXT,
      current_period_start     TEXT,
      current_period_end       TEXT,
      benefits_used_this_period TEXT,          -- JSON
      status                   TEXT DEFAULT 'ACTIVE', -- ACTIVE | CANCELLED | EXPIRED
      folio_id                 TEXT,
      created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spa_client_mem_client ON spa_client_memberships(client_id, status);
  `);

  // ── Gift cards (parity) ────────────────────────────────────────────────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_gift_cards (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL,
      initial_value DOUBLE PRECISION NOT NULL DEFAULT 0,
      balance       DOUBLE PRECISION NOT NULL DEFAULT 0,
      purchaser_name TEXT,
      recipient_name TEXT,
      expires_at    TIMESTAMP,
      status        TEXT DEFAULT 'ACTIVE',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_gift_code ON spa_gift_cards(code);
    CREATE TABLE IF NOT EXISTS spa_gift_card_txns (
      id           TEXT PRIMARY KEY,
      gift_card_id TEXT NOT NULL,
      delta        DOUBLE PRECISION NOT NULL,
      reason       TEXT,
      folio_id     TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Public-facing spa profile (hero image, tagline, offers bulletin) ─────────
  await tenantDb.exec(`
    CREATE TABLE IF NOT EXISTS spa_profile (
      restaurant_id  TEXT PRIMARY KEY,
      hero_image_url TEXT,
      tagline        TEXT,
      offers         TEXT,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Whether every treatment needs a signed consent and a health intake before
  // check-in (a treatment can also require it on its own). Here, after the table.
  await tenantDb.exec(`ALTER TABLE spa_profile ADD COLUMN IF NOT EXISTS require_intake_consent INT DEFAULT 0`).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// Seed — idempotent. Guarded by an existence check so re-enabling never
// duplicates. Seeds enough to demo the full loop (incl. a SPA_PRODUCT
// consumable + a SPA_RETAIL item so the supply-chain link is exercisable).
// Returns the number of services seeded (0 if already populated).
// ════════════════════════════════════════════════════════════════════════

function genId(prefix: string): string {
  // Time-ordered-ish id without relying on Date in workflow contexts; here in
  // the server runtime Date is available.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function seedSpaDefaults(tenantDb: DbInterface): Promise<number> {
  const existing: any = await tenantDb.get("SELECT COUNT(*)::int AS c FROM spa_services");
  if (Number(existing?.c || 0) > 0) return 0;

  const services = [
    { name: "Swedish Massage", category: "MASSAGE", duration: 60, price: 2500 },
    { name: "Deep Tissue Massage", category: "MASSAGE", duration: 90, price: 3500 },
    { name: "Aromatherapy Massage", category: "MASSAGE", duration: 60, price: 2800 },
    { name: "Classic Facial", category: "FACIAL", duration: 45, price: 1800 },
    { name: "Anti-Ageing Facial", category: "FACIAL", duration: 75, price: 3200 },
    { name: "Body Scrub & Wrap", category: "BODY", duration: 90, price: 3800 },
    { name: "Sauna Session", category: "SAUNA", duration: 30, price: 900, requires_therapist: 0 },
    { name: "Manicure & Pedicure", category: "SALON", duration: 60, price: 1500 },
  ];
  const serviceIds: string[] = [];
  let order = 0;
  for (const s of services) {
    const id = genId("SPASVC");
    serviceIds.push(id);
    await tenantDb.run(
      `INSERT INTO spa_services (id, name, category, duration_min, buffer_after_min, price, gst_percent, requires_room, requires_therapist, display_order, is_active)
       VALUES (?, ?, ?, ?, 10, ?, 18, 1, ?, ?, 1)`,
      [id, s.name, s.category, s.duration, s.price, (s as any).requires_therapist ?? 1, order++]
    );
  }

  // Add-on for the first service
  await tenantDb.run(
    `INSERT INTO spa_service_addons (id, service_id, name, extra_duration_min, extra_price, gst_percent, is_active)
     VALUES (?, ?, 'Hot Stone Add-on', 15, 600, 18, 1)`,
    [genId("SPAADD"), serviceIds[0]]
  );

  // Treatment cabins
  for (const name of ["Cabin 1", "Cabin 2", "Cabin 3"]) {
    await tenantDb.run(
      `INSERT INTO spa_resources (id, name, resource_type, capacity, is_active) VALUES (?, ?, 'CABIN', 1, 1)`,
      [genId("SPARES"), name]
    );
  }

  // Supply-chain demo items as ingredients (item_type discriminator) — these
  // flow through the validated PO→GRN→supplier-invoice→payment chain. Only
  // seeded if not already present (name match) to stay idempotent.
  //
  // Seeded at ZERO stock. They were seeded with 10 l and 25 pcs that nobody
  // bought, written straight into current_stock_qty with no line in the stock
  // ledger — invented stock on a real property, and a stock figure the ledger
  // could never agree with (the candle read 23 on the shelf and -2 in the
  // month-end close on three tenants, found 15 Sep 2026). Stock arrives the
  // way all stock does: a goods receipt or a recorded adjustment.
  const oil: any = await tenantDb.get("SELECT id FROM ingredients WHERE name = 'Spa Massage Oil' LIMIT 1");
  let oilId = oil?.id;
  if (!oilId) {
    oilId = genId("ING");
    await tenantDb.run(
      `INSERT INTO ingredients (id, name, item_type, category, unit, current_stock_qty, reorder_point, par_level, default_unit_price, gst_percent, is_active)
       VALUES (?, 'Spa Massage Oil', 'SPA_PRODUCT', 'Spa Supplies', 'l', 0, 2, 20, 800, 18, 1)`,
      [oilId]
    );
  }
  const candle: any = await tenantDb.get("SELECT id FROM ingredients WHERE name = 'Aroma Candle (Retail)' LIMIT 1");
  if (!candle?.id) {
    await tenantDb.run(
      `INSERT INTO ingredients (id, name, item_type, category, unit, current_stock_qty, reorder_point, par_level, default_unit_price, gst_percent, is_active)
       VALUES (?, 'Aroma Candle (Retail)', 'SPA_RETAIL', 'Spa Retail', 'pcs', 0, 5, 50, 450, 18, 1)`,
      [genId("ING")]
    );
  }
  // Link the first massage service to consume oil
  await tenantDb.run(
    `INSERT INTO spa_service_consumables (id, service_id, ingredient_id, qty_per_service, unit)
     VALUES (?, ?, ?, 0.05, 'l')`,
    [genId("SPACON"), serviceIds[0], oilId]
  );

  // Sample prepaid package + membership
  await tenantDb.run(
    `INSERT INTO spa_packages (id, name, service_id, total_sessions, price, gst_percent, validity_days, is_active)
     VALUES (?, '5 Massage Series', ?, 5, 11000, 18, 180, 1)`,
    [genId("SPAPKG"), serviceIds[0]]
  );
  await tenantDb.run(
    `INSERT INTO spa_membership_plans (id, name, tier, monthly_fee, gst_percent, benefits, is_active)
     VALUES (?, 'Wellness Club', 'GOLD', 1999, 18, ?, 1)`,
    [genId("SPAMEM"), JSON.stringify({ discount_pct: 10, free_services_per_month: 0, included_service_ids: [] })]
  );

  return serviceIds.length;
}
