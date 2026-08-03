# Checklists — User Manual (Rooms & Event Halls)

_Atithi‑Setu · End‑to‑end guide for owners, managers and front‑of‑house staff_

Checklists make sure your team follows the process at every important moment of a
stay or an event — arrival prep, housekeeping, cleaning, inspections, turnover — so
service quality stays consistent. This manual covers **how to set them up, when they
fire, who does them, and how they connect to rooms and event halls.**

---

## 1. Concepts (read this once)

| Term | What it means |
|---|---|
| **Template** | The *master* definition of a checklist — its name, the facility it applies to (hotel room / event hall), the trigger that raises it, and its ordered list of task steps. Owners/managers create these. |
| **Checklist (instance)** | A *live copy* of a template, raised automatically at the right moment and attached to a specific room, booking or hall. This is what staff actually tick off. |
| **Trigger** | The event that raises a checklist — e.g. "On check‑in", "When room → Cleaning", "On new booking". |
| **Facility** | What the checklist is about: **Hotel room**, **Event hall**, or **Generic**. |
| **Mandatory step** | A task that *must* be ticked before the checklist can be completed (and, for check‑in/check‑out, before the operation is allowed). |
| **Blocking vs non‑blocking** | Only **check‑in** and **check‑out** checklists can *block* an operation. Every other trigger (statuses, new booking, mid‑stay, cleaning, daily…) is **non‑blocking** — it is raised for visibility and quality but never stops your team from working. |

> **The golden rule:** if a checklist is *not applied* (no template configured for that
> trigger, or the owner switched enforcement off), the system **never blocks** the
> business operation. Nothing you configure here can lock your front desk out.

---

## 2. Where things live

| Screen | Who | Purpose |
|---|---|---|
| **PMS → Checklist Templates** | Owner / Admin | Create & edit **room** checklist templates. |
| **Events & Convention → Checklist Templates** | Owner / Admin | Create & edit **event‑hall** checklist templates. |
| **PMS → Status Board** | Hotel/Events staff | See every room & hall at a glance; flip a status (which also raises status checklists). |
| **Events → Venues** | Events staff | Manage halls; each hall has a **Status** dropdown. |
| **My Checklist** (top nav) | Everyone | Your personal queue — the checklists assigned to you or your role. |
| **Checklists → Checklist Board** | Owner / Manager | Every open checklist across the property, who owns it, how overdue it is. |
| **Hotel → Settings → Business Rules** | Owner | The two enforcement toggles (see §6). |

---

## 3. The full list of triggers

When you create or edit a template you pick **one trigger**. The editor only shows the
triggers valid for the facility type you selected.

### Hotel room — booking lifecycle
| Trigger | Fires when… | Blocking? |
|---|---|---|
| **On new booking** | A booking is created/confirmed | No |
| **On room assigned** | A room is assigned / reassigned to a booking | No |
| **On check‑in** | A guest checks in | **Yes**, if enforcement is on |
| **On check‑out** | A guest checks out | **Yes** (holds the room), if enforcement is on |

### Hotel room — recurring during a stay
| Trigger | Fires… | Blocking? |
|---|---|---|
| **Mid‑stay / overstay** | Every **N nights** of an in‑house stay (you set N per template) | No |
| **Room cleaning** | During the stay at the **per‑booking cadence** the front desk sets at check‑in (daily / every 2 nights / none) | No |

### Hotel room — status changes
| Trigger | Fires when the room becomes… | Blocking? |
|---|---|---|
| **When room → Vacant / Occupied / Cleaning / Maintenance / Blocked** | that status (manually on the Status Board, or automatically on check‑in → Occupied, check‑out → Cleaning) | No |

### Event hall
| Trigger | Fires when… | Blocking? |
|---|---|---|
| **On event completion** | An event booking is marked complete | No |
| **When hall → Vacant / Occupied / Cleaning / Maintenance / Blocked** | The hall status is set to that value | No |

### Anywhere
| Trigger | Fires… | Blocking? |
|---|---|---|
| **Daily** | Every morning per facility (05:00 IST cron) | No |
| **Manual / on‑demand** | When staff start it by hand (inspections, audits) | No |

---

## 4. Setting up a checklist (owner/manager)

1. Go to **Checklist Templates** (PMS for rooms, Events & Convention for halls).
2. Click **+ New template**.
3. Fill in:
   - **Name** — e.g. "Arrival prep", "Departure clean", "Weekly deep clean", "Hall reset".
   - **Category** — grouping (PMS / Event Hall / Inspection / Event). Optional.
   - **Facility type** — Hotel room, Event hall, or Generic.
   - **Trigger** — from the list in §3. (Set **Mid‑stay recurrence** = N nights when you pick Mid‑stay.)
   - **Steps** — add the tasks in order; mark the essential ones **mandatory**.
4. **Applies to** — assign the template to specific **rooms**, **room types**, or **venues**, or choose **Apply to all** of that facility type. (No assignment = applies to all by default.)
5. **Save.**

> The two seeded system templates — **PMS · Check‑Out** and **Room Cleaning** — already
> exist so the core flows work out of the box. Edit their steps to match your property.

**Active / Inactive.** Every template has a **Status** in the list — **Active** or
**Inactive** — with an Activate / Deactivate button. **Only Active templates are ever
triggered.** Deactivate a template (including a system one) to switch its checklist off
temporarily without deleting it; Activate it again to bring it back. This is the switch to
use when you want to stop a checklist from firing.

---

## 5. What happens across a stay (the automatic flow)

```
Booking confirmed ──► "On new booking" checklist  +  Check‑in checklist attached (if enforced)
Room assigned    ──► "On room assigned" checklist
Check‑in         ──► [gate: mandatory check‑in tasks]  ► Room → OCCUPIED
                     ► Check‑out checklist planned  ► Overstay schedule set (if stay > 1 night)
During the stay  ──► Mid‑stay every N nights   +   Room cleaning at the guest's cadence
Check‑out        ──► Room → CLEANING (held until the check‑out checklist is done, if enforced)
```

- **Attached early:** the check‑in checklist appears the moment a booking is confirmed, so
  the front desk can prep before the guest arrives.
- **Overstay** only applies to stays **longer than one night**, at the cadence you set on the
  mid‑stay template.
- **Idempotent:** the system never raises the same checklist twice for the same booking.

---

## 6. Owner enforcement settings (Hotel → Settings → Business Rules)

| Setting | Default | When ON | When OFF |
|---|---|---|---|
| **Validate checklist on check‑in** | On | Check‑in is refused until every **mandatory** check‑in task is ticked. | Check‑in is never blocked; the checklist is still raised for prep. |
| **Validate checklist on check‑out** | On | The room is held in **Cleaning** (not re‑bookable) until the check‑out checklist is done. | Rooms release freely; the checklist is still raised for housekeeping. |

Turn either off for a property that doesn't want that enforcement — the checklists still
appear on the worklist, they simply stop gating.

---

## 7. Room cleaning cadence (per guest)

At **check‑in**, the wizard shows a **Room cleaning** choice: **Every day**, **Every 2
nights**, or **No cleaning**. Set it from the guest's preference. The daily cron then raises
the Room Cleaning checklist for that stay accordingly (first clean after the chosen number
of nights, then repeating). Departure day is skipped — the check‑out clean covers it.

---

## 8. Event halls

Event halls now have a **status** just like rooms. On **Events → Venues**, each hall has a
**Status** dropdown: **Vacant / Occupied / Cleaning / Maintenance / Blocked**. Changing it
raises any **"When hall → …"** checklist you configured (non‑blocking). Use it to trigger a
post‑event reset, a deep clean before a wedding, or a maintenance inspection.

---

## 9. Doing checklists (staff)

### My Checklist
Your personal queue as a **smart table** — sort any column, filter, choose which columns to
show (gear), search and export. Click a checklist's name to open it:
- **Summary** — tick each task; add a **remark** per task; **Mark complete** when done (mandatory tasks must be ticked first).
- **Audit log** — every action, who did it, when.
- **Where Used / Related** — the room, booking or hall it's attached to (click to open it in the same frame).

### Checklist Board (managers)
Every open checklist across the property, with KPIs (Open / Blocking release / Open > 24h),
filters, a **Due** column (overdue shown in red ⏰) and the same drill‑in tree menu.

### Status Board
A colour‑coded grid of every room (by floor) and every hall, each with its status and a
per‑tile status dropdown. Flip a status here and it saves instantly — and raises the matching
status checklist. Room tiles link into the room's tree menu.

---

## 10. Due dates & reminders

Every checklist carries a **due date** derived from the stay: check‑in → arrival day,
check‑out → departure day, mid‑stay → the milestone night, daily/cleaning → that day. A
morning sweep notifies the **assigned person or team** about any checklist that is **past due
and still incomplete** — at most one reminder per checklist per day. Due dates (and overdue
highlighting) show on **My Checklist** and the **Checklist Board**.

Notifications also fire when a checklist is **assigned** and when it is **completed**.

---

## 11. Roles & who gets what

| Role | Typical checklist assignment |
|---|---|
| **Front Desk** | Check‑in / arrival prep |
| **Housekeeping** | Cleaning, mid‑stay, daily, check‑out cleaning |
| **Maintenance** | Manual inspections, maintenance‑status checklists |
| **Manager / Owner** | See everything on the Checklist Board; can override a blocking checklist to release a room |

---

## 12. Quick FAQ

- **A room is stuck in Cleaning and won't go Vacant.** Its check‑out checklist has an open
  mandatory task. Finish it, or a manager can override on the Status Board. To stop this
  behaviour entirely, turn off **Validate checklist on check‑out**.
- **Check‑in is blocked.** A mandatory check‑in task is unticked. Complete it in the wizard,
  or turn off **Validate checklist on check‑in**.
- **I created a template but nothing appears.** Triggers fire on *transitions* — e.g. the
  check‑in checklist only fires at the moment of check‑in, not retroactively for guests
  already checked in. Make a fresh booking (or the relevant status change) to see it.
- **Will status/booking checklists ever block us?** No. Only check‑in and check‑out can
  block, and only when their enforcement toggle is on.

---

## Appendix — End‑to‑end (QA) validation

The checklist flows are covered by an automated end‑to‑end test that an owner can run:

```bash
node test-scripts/e2e_checklists.mjs
```

It logs in with owner credentials, creates throwaway templates, and validates (self‑cleaning):

| Case | Verifies |
|---|---|
| `E2E-SETUP`, `E2E-SETUP-CLEANING` | Templates for check‑in / check‑out / mid‑stay / daily / **cleaning** are accepted |
| `E2E-DAILY-HALL` | Daily run raises a hall checklist |
| `E2E-VENUE-STATUS` | Setting a hall to **Cleaning** raises the `VENUE_CLEANING` checklist |
| `E2E-CHECKIN-EARLY` | Check‑in checklist attaches **at booking‑confirm**, before check‑in |
| `E2E-CHECKIN` / `E2E-MIDSTAY` | Check‑in and overstay checklists raise for an in‑house room |
| `E2E-OVERDUE-SWEEP` | The due‑date reminder sweep is wired |
| `E2E-CLEANING` | The daily run raises **room cleaning** at the per‑booking cadence |
| `E2E-CHECKOUT` / `E2E-GATING` | Check‑out sets the room to Cleaning + a blocking checklist; completing it releases the room |
| `E2E-CO-SETTING` / `E2E-CO-NONBLOCK` | With **validate‑on‑check‑out OFF**, the check‑out checklist is raised **non‑blocking** |

A green run (0 failures) means the whole rooms‑and‑halls checklist integration is behaving
end‑to‑end.
