/**
 * e2e_checklists.mjs — walk a hotel-room booking AND an event-hall booking through
 * their whole lifecycle and assert exactly which checklist fires at each step:
 *
 *   ROOM:  create → BOOKING_NEW + CHECK_IN(attached early)
 *          check-in → CHECK_IN(gate) + ROOM_OCCUPIED + CHECK_OUT(planned) + MID_STAY(sched)
 *          daily cron → DAILY + MID_STAY + CLEANING
 *          check-out → CHECK_OUT(blocking, holds room) + ROOM_CLEANING ; complete → room VACANT
 *   HALL:  daily cron → DAILY ; status board → VENUE_<status>
 *          complete event ("checkout") → EVENT_COMPLETE(blocking) → gates the next
 *          event's confirm on that venue → completing the clean releases it
 *
 * It is SELF-CLEANING: it closes the jobs it raises, cancels/checks-out its test
 * booking, deletes its templates, and restores the "ID at check-in" setting it may
 * have toggled. It does create real (throwaway) scaffolding while it runs.
 *
 * Run (owner credentials required):
 *   OWNER_EMAIL=you@x.com OWNER_PASSWORD=secret RESTAURANT_ID=RESTO-1003 \
 *     node test-scripts/e2e_checklists.mjs
 *   (BASE_URL defaults to https://erp.atithi-setu.com)
 */

const BASE = process.env.BASE_URL || 'https://erp.atithi-setu.com';
const EMAIL = process.env.OWNER_EMAIL || process.env.LIVE_LOGIN_ID || '';
const PASSWORD = process.env.OWNER_PASSWORD || process.env.LIVE_PASSWORD || '';
const RID = process.env.RESTAURANT_ID || process.env.LIVE_RESTAURANT_ID || '';
if (!EMAIL || !PASSWORD || !RID) {
  console.error('\nMissing credentials. Set OWNER_EMAIL, OWNER_PASSWORD, RESTAURANT_ID.\n');
  process.exit(1);
}

let token = '';
const api = async (m, p, b) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text() };
};
let passN = 0, failN = 0, skipN = 0;
const ok = (c, id, msg, note = '') => { c ? passN++ : failN++; console.log(`${c ? '✅ PASS' : '❌ FAIL'}  ${id} — ${msg}${note ? '  | ' + note : ''}`); };
const skip = (id, msg, note = '') => { skipN++; console.log(`⚠️  SKIP  ${id} — ${msg}${note ? '  | ' + note : ''}`); };
const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);

const P = `/api/restaurant/${RID}`;
const created = { templates: [], bookingId: null, evBookings: [], restoreReqId: undefined };
const asList = (d) => Array.isArray(d) ? d : (d?.rooms || d?.venues || []);
const jobsAll = async () => { const r = await api('GET', `${P}/housekeeping/jobs?status=ALL`); return Array.isArray(r.data) ? r.data : []; };
const jobsFor = async (facilityId, trigger) => (await jobsAll()).filter(j => j.facility_id === facilityId && (!trigger || j.trigger_event === trigger));
const closeJob = async (jid) => {
  const j = await api('GET', `${P}/housekeeping/jobs/${jid}`);
  for (const t of (j.data?.tasks || [])) await api('PATCH', `${P}/housekeeping/jobs/${jid}/tasks/${t.id}`, { is_done: true });
  await api('POST', `${P}/housekeeping/jobs/${jid}/complete`, {});
};

// Terminate any leftover throwaway "E2E Guest" bookings (this run's + any stranded
// by a prior failed run) so a test never leaves a room occupied. Checked-in bookings
// are comped out (waive:true) since the test folio has an unpaid balance.
async function sweepE2EBookings() {
  try {
    const list = await api('GET', `${P}/hotel/bookings`);
    const rows = (Array.isArray(list.data) ? list.data : (list.data?.bookings || []));
    for (const b of rows) {
      if (!String(b.guest_name || '').startsWith('E2E Guest')) continue;
      if (b.status === 'CHECKED_IN') { try { await api('POST', `${P}/hotel/bookings/${b.id}/checkout`, { payment_method: 'CASH', waive: true }); } catch {} }
      else if (b.status === 'BOOKED') { try { await api('POST', `${P}/hotel/bookings/${b.id}/cancel`, { reason: 'E2E cleanup' }); } catch {} }
    }
  } catch {}
}

async function cleanup() {
  await sweepE2EBookings();
  try {
    // Close every OPEN job spawned by our templates (any run, any facility).
    const mine = new Set(created.templates);
    for (const j of await jobsAll()) if (j.status === 'OPEN' && mine.has(j.template_id)) { try { await closeJob(j.id); } catch {} }
    // Close any remaining OPEN jobs tied to this run's test bookings (e.g. the
    // system Room-Cleaning / Event-Complete templates' jobs, which aren't in
    // created.templates) so no test leaves a room or venue held.
    const testBk = new Set([created.bookingId, created.bookingId2, ...created.evBookings].filter(Boolean));
    if (testBk.size) for (const j of await jobsAll()) if (j.status === 'OPEN' && testBk.has(j.source_ref)) { try { await closeJob(j.id); } catch {} }
  } catch {}
  // Cancel any confirmable throwaway event bookings (COMPLETED ones can't be cancelled — harmless).
  for (const eb of created.evBookings) { try { await api('POST', `${P}/events/bookings/${eb}/cancel`, { reason: 'E2E cleanup' }); } catch {} }
  for (const tid of created.templates) { try { await api('DELETE', `${P}/checklists/templates/${tid}`); } catch {} }
  if (created.restoreReqId !== undefined) { try { await api('PATCH', `${P}/hotel/settings`, { require_id_at_checkin: !!created.restoreReqId }); } catch {} }
  if (created.restoreCheckoutValidate !== undefined) { try { await api('PATCH', `${P}/hotel/settings`, { checklist_validate_on_checkout: !!created.restoreCheckoutValidate }); } catch {} }
}

(async () => {
  let r = await api('POST', '/api/auth/owner/login', { identifier: EMAIL, password: PASSWORD });
  if (r.status !== 200) r = await api('POST', '/api/auth/login', { loginId: EMAIL, password: PASSWORD, restaurantId: RID });
  token = r.data?.jwt_token || r.data?.token || '';
  if (!token) { console.error('❌ LOGIN FAILED —', r.status, JSON.stringify(r.data)); process.exit(1); }
  console.log(`\n═══ Checklist trigger e2e — ${RID} @ ${BASE} ═══\n`);
  await sweepE2EBookings(); // clear any stray test bookings left by a prior failed run
  const tag = Date.now();
  const mkTpl = async (body) => { const res = await api('POST', `${P}/checklists/templates`, body); if (res.status === 201 && res.data?.id) created.templates.push(res.data.id); return res; };

  try {
    // ── Scaffolding: the four templates under test ──
    const ciT = await mkTpl({ name: `E2E Check-In ${tag}`, facility_type: 'ROOM', trigger_event: 'CHECK_IN', blocks_release: false, steps: [{ label: 'Place welcome amenities', is_mandatory: true }] });
    const coT = await mkTpl({ name: `E2E Check-Out ${tag}`, facility_type: 'ROOM', trigger_event: 'CHECK_OUT', blocks_release: true, steps: [{ label: 'Strip & remake bed', is_mandatory: true }, { label: 'Sanitise bathroom', is_mandatory: true }] });
    const msT = await mkTpl({ name: `E2E Mid-Stay ${tag}`, facility_type: 'ROOM', trigger_event: 'MID_STAY', recurrence_nights: 1, blocks_release: false, steps: [{ label: 'Replace towels', is_mandatory: true }] });
    const dlT = await mkTpl({ name: `E2E Hall Daily ${tag}`, facility_type: 'EVENT', trigger_event: 'DAILY', blocks_release: false, steps: [{ label: 'Wipe surfaces & set chairs', is_mandatory: true }] });
    const clT = await mkTpl({ name: `E2E Cleaning ${tag}`, facility_type: 'ROOM', trigger_event: 'CLEANING', blocks_release: false, steps: [{ label: 'Change linen & towels', is_mandatory: true }] });
    const vcT = await mkTpl({ name: `E2E Hall Clean ${tag}`, facility_type: 'EVENT', trigger_event: 'VENUE_CLEANING', blocks_release: false, steps: [{ label: 'Wipe hall & reset chairs', is_mandatory: true }] });
    // Booking-lifecycle + room-status templates (all NON-blocking) so we can assert the
    // BOOKING_NEW / ROOM_OCCUPIED / ROOM_CLEANING triggers fire at the right moments.
    const bnT = await mkTpl({ name: `E2E Booking-New ${tag}`, facility_type: 'ROOM', trigger_event: 'BOOKING_NEW', blocks_release: false, steps: [{ label: 'Pre-assign welcome kit', is_mandatory: false }] });
    const roT = await mkTpl({ name: `E2E Room-Occupied ${tag}`, facility_type: 'ROOM', trigger_event: 'ROOM_OCCUPIED', blocks_release: false, steps: [{ label: 'Log occupancy', is_mandatory: false }] });
    const rcT = await mkTpl({ name: `E2E Room-Cleaning ${tag}`, facility_type: 'ROOM', trigger_event: 'ROOM_CLEANING', blocks_release: false, steps: [{ label: 'Turn-down clean', is_mandatory: false }] });
    // EVENT_COMPLETE template (BLOCKING) — the event-hall "checkout": completing an event
    // raises it, and it holds the venue (gates the next event's confirm) until cleaned.
    const ecT = await mkTpl({ name: `E2E Hall Complete ${tag}`, facility_type: 'EVENT', trigger_event: 'EVENT_COMPLETE', blocks_release: true, steps: [{ label: 'Deep-clean hall after event', is_mandatory: true }] });
    ok(ciT.status === 201 && coT.status === 201 && msT.status === 201 && dlT.status === 201, 'E2E-SETUP', 'Created check-in / check-out / mid-stay / daily templates', `HTTP ${ciT.status}/${coT.status}/${msT.status}/${dlT.status}`);
    ok(clT.status === 201, 'E2E-SETUP-CLEANING', 'CLEANING trigger accepted by the template editor', `HTTP ${clT.status}`);
    ok(bnT.status === 201 && roT.status === 201 && rcT.status === 201 && ecT.status === 201, 'E2E-SETUP-LIFECYCLE', 'Created booking-new / room-occupied / room-cleaning / event-complete templates', `HTTP ${bnT.status}/${roT.status}/${rcT.status}/${ecT.status}`);
    if (ciT.status === 403) { console.error('\nNeed OWNER role to create templates — aborting.\n'); return; }

    // ── EVENT-HALL DAILY (independent of bookings) ──
    const venues = asList((await api('GET', `${P}/events/venues`)).data);
    if (venues.length) {
      const run = await api('POST', `${P}/checklists/run-scheduled`, {});
      const anyDaily = (await Promise.all(venues.map(v => jobsFor(v.id, 'DAILY')))).some(a => a.some(j => created.templates.includes(j.template_id)));
      ok(run.status === 200 && anyDaily, 'E2E-DAILY-HALL', 'Daily run raised a DAILY checklist for an event hall', `raised=${run.data?.raised}`);
      // Hall status board → VENUE_<status> checklist (non-blocking).
      const vId = venues[0].id;
      const vs = await api('PATCH', `${P}/events/venues/${vId}/status`, { status: 'CLEANING' });
      const vJobs = (await jobsFor(vId, 'VENUE_CLEANING')).filter(j => created.templates.includes(j.template_id));
      ok((vs.status === 200) && vJobs.length >= 1, 'E2E-VENUE-STATUS', 'Setting a hall to CLEANING raised the VENUE_CLEANING checklist (non-blocking)', `http=${vs.status}, jobs=${vJobs.length}`);
      await api('PATCH', `${P}/events/venues/${vId}/status`, { status: 'VACANT' }).catch(() => {}); // reset

      // ── EVENT-HALL LIFECYCLE: booking → complete ("checkout") → gate → release ──
      // Faithfully walks a hall booking to completion and proves the EVENT_COMPLETE
      // checklist (a) fires on complete, (b) is blocking, (c) gates the NEXT event's
      // confirm on that venue, and (d) releases the venue once cleaned.
      const evA = await api('POST', `${P}/events/bookings`, { venue_id: vId, customer_name: `E2E Event ${tag}`, customer_phone: '9990000200', event_date: day(0), guest_count: 20 });
      if (evA.status === 201 && evA.data?.id) {
        created.evBookings.push(evA.data.id);
        const comp = await api('POST', `${P}/events/bookings/${evA.data.id}/complete`, {});
        const ecJobs = (await jobsFor(vId, 'EVENT_COMPLETE')).filter(j => created.templates.includes(j.template_id));
        const ecBlocking = ecJobs.filter(j => j.status === 'OPEN' && Number(j.blocks_release) === 1);
        ok(comp.status === 200 && ecBlocking.length >= 1, 'E2E-EVT-COMPLETE', 'Completing an event raised a BLOCKING EVENT_COMPLETE checklist for the hall', `http=${comp.status}, blocking=${ecBlocking.length}`);

        // A NEW booking on the same venue cannot be confirmed while the cleaning checklist is open.
        const evB = await api('POST', `${P}/events/bookings`, { venue_id: vId, customer_name: `E2E Event ${tag}b`, customer_phone: '9990000201', event_date: day(30), guest_count: 20 });
        if (evB.status === 201 && evB.data?.id) {
          created.evBookings.push(evB.data.id);
          const conf1 = await api('POST', `${P}/events/bookings/${evB.data.id}/confirm`, {});
          ok(conf1.status === 409 && conf1.data?.housekeeping_blocked === true, 'E2E-EVT-GATE', 'Confirming a new event is blocked while the hall cleaning checklist is open', `http=${conf1.status}, blocked=${conf1.data?.housekeeping_blocked}`);

          // Complete the cleaning checklist(s) → venue frees → confirm now succeeds.
          for (const j of (await jobsFor(vId, 'EVENT_COMPLETE'))) if (j.status === 'OPEN' && Number(j.blocks_release) === 1) { try { await closeJob(j.id); } catch {} }
          const conf2 = await api('POST', `${P}/events/bookings/${evB.data.id}/confirm`, {});
          ok(conf2.status !== 409 || conf2.data?.housekeeping_blocked !== true, 'E2E-EVT-RELEASE', 'After the cleaning checklist is done, the venue frees and the next event confirms', `http=${conf2.status}`);
        } else {
          ['E2E-EVT-GATE', 'E2E-EVT-RELEASE'].forEach(id => skip(id, 'Hall gate', `could not create 2nd event booking HTTP ${evB.status}`));
        }
      } else {
        ['E2E-EVT-COMPLETE', 'E2E-EVT-GATE', 'E2E-EVT-RELEASE'].forEach(id => skip(id, 'Hall lifecycle', `could not create event booking HTTP ${evA.status}`));
      }
    } else {
      skip('E2E-DAILY-HALL', 'Event-hall daily', 'events not enabled or no venues on this tenant');
      skip('E2E-VENUE-STATUS', 'Hall status board', 'events not enabled or no venues on this tenant');
      ['E2E-EVT-COMPLETE', 'E2E-EVT-GATE', 'E2E-EVT-RELEASE'].forEach(id => skip(id, 'Hall lifecycle', 'events not enabled or no venues on this tenant'));
    }

    // ── CHECK-IN → OVERSTAY → CHECK-OUT (need hotel + a bookable room) ──
    const rooms = asList((await api('GET', `${P}/hotel/rooms`)).data);
    if (!rooms.length) {
      ['E2E-CHECKIN', 'E2E-MIDSTAY', 'E2E-CHECKOUT', 'E2E-GATING'].forEach(id => skip(id, 'Room-flow triggers', 'hotel not enabled or no rooms'));
      return;
    }
    let bookingId = null, roomId = null;
    for (const room of rooms.slice(0, 6)) {
      const bk = await api('POST', `${P}/hotel/bookings`, { room_id: room.id, guest_name: `E2E Guest ${tag}`, guest_phone: '9990000123', num_guests: 1, check_in_date: day(0), check_out_date: day(3), booking_source: 'DIRECT', room_rate: Number(room.base_price || 1500) });
      if (bk.status === 201 && bk.data?.id) { bookingId = bk.data.id; roomId = room.id; break; }
    }
    if (!bookingId) { ['E2E-CHECKIN', 'E2E-MIDSTAY', 'E2E-CHECKOUT', 'E2E-GATING'].forEach(id => skip(id, 'Room-flow triggers', 'could not create a test booking (date conflicts)')); return; }
    created.bookingId = bookingId;

    // The CHECK_IN checklist should attach the moment the booking is confirmed —
    // before check-in — when checklist_validate_on_checkin is on (the default).
    const preCi = (await jobsFor(roomId, 'CHECK_IN')).filter(j => created.templates.includes(j.template_id));
    ok(preCi.length >= 1, 'E2E-CHECKIN-EARLY', 'Check-in checklist attached at booking-confirm time (before check-in)', `${preCi.length} pre-check-in job(s)`);

    // Creating the booking should also raise the BOOKING_NEW checklist (non-blocking).
    const bnJobs = (await jobsFor(roomId, 'BOOKING_NEW')).filter(j => created.templates.includes(j.template_id));
    ok(bnJobs.length >= 1, 'E2E-BOOKING-NEW', 'Booking creation raised the BOOKING_NEW checklist (non-blocking)', `${bnJobs.length} booking-new job(s)`);

    // Check-in (turn ID-requirement off for the test if it blocks; restored in cleanup).
    let cin = await api('POST', `${P}/hotel/bookings/${bookingId}/checkin`, {});
    if (cin.status === 400 && (cin.data?.missing_field === 'guest_documents' || cin.data?.require_id_at_checkin)) {
      const st0 = await api('GET', `${P}/hotel/settings`);
      created.restoreReqId = st0.data?.require_id_at_checkin;
      await api('PATCH', `${P}/hotel/settings`, { require_id_at_checkin: false });
      cin = await api('POST', `${P}/hotel/bookings/${bookingId}/checkin`, {});
    }
    if (!(cin.status === 200 || cin.data?.booking)) {
      ok(false, 'E2E-CHECKIN', 'Check-in request', `HTTP ${cin.status} — ${JSON.stringify(cin.data).slice(0, 160)}`);
      ['E2E-MIDSTAY', 'E2E-CHECKOUT', 'E2E-GATING'].forEach(id => skip(id, 'Room-flow triggers', 'check-in failed'));
      return;
    }
    const ciJobs = (await jobsFor(roomId, 'CHECK_IN')).filter(j => created.templates.includes(j.template_id));
    ok(ciJobs.length >= 1, 'E2E-CHECKIN', 'Check-in raised the check-in checklist for the room', `${ciJobs.length} check-in job(s)`);
    // Check-in flips the room to OCCUPIED → the ROOM_OCCUPIED status checklist (non-blocking).
    const roJobs = (await jobsFor(roomId, 'ROOM_OCCUPIED')).filter(j => created.templates.includes(j.template_id));
    ok(roJobs.length >= 1, 'E2E-ROOM-OCCUPIED', 'Check-in raised the ROOM_OCCUPIED status checklist (non-blocking)', `${roJobs.length} occupied job(s)`);

    // Overstay — evaluate the scheduled run "as of tomorrow" so nights = 1 (mid-stay every 1 night).
    const runMs = await api('POST', `${P}/checklists/run-scheduled`, { as_of: day(1) });
    const msJobs = (await jobsFor(roomId, 'MID_STAY')).filter(j => created.templates.includes(j.template_id));
    ok(runMs.status === 200 && msJobs.length >= 1, 'E2E-MIDSTAY', 'Overstay run raised the mid-stay checklist for the in-house room', `raised=${runMs.data?.raised}, jobs=${msJobs.length}`);
    ok(typeof runMs.data?.overdue_notified === 'number', 'E2E-OVERDUE-SWEEP', 'run-scheduled reports an overdue-notified count (due-date reminder sweep is wired)', `overdue_notified=${runMs.data?.overdue_notified}`);
    const clJobs = (await jobsFor(roomId, 'CLEANING')).filter(j => created.templates.includes(j.template_id));
    ok(clJobs.length >= 1, 'E2E-CLEANING', 'Daily run raised the room-cleaning checklist at the per-booking cadence (default daily)', `cleaning jobs=${clJobs.length}`);

    // Check-out — room must go CLEANING and a BLOCKING check-out checklist must open.
    // waive:true comps the throwaway test folio so the checkout isn't blocked by the
    // outstanding-balance guard (no real revenue is posted for a comped folio).
    const cout = await api('POST', `${P}/hotel/bookings/${bookingId}/checkout`, { payment_method: 'CASH', waive: true });
    if (!(cout.status === 200 || cout.status === 201)) {
      ok(false, 'E2E-CHECKOUT', 'Check-out request', `HTTP ${cout.status} — ${JSON.stringify(cout.data).slice(0, 160)}`);
      skip('E2E-GATING', 'Release gating', 'check-out failed');
      return;
    }
    const roomRow = asList((await api('GET', `${P}/hotel/rooms`)).data).find(x => x.id === roomId);
    const coJobs = (await jobsFor(roomId, 'CHECK_OUT')).filter(j => created.templates.includes(j.template_id));
    const blocking = coJobs.filter(j => j.status === 'OPEN' && Number(j.blocks_release) === 1);
    ok(roomRow?.status === 'CLEANING' && blocking.length >= 1, 'E2E-CHECKOUT', 'Check-out set room to CLEANING and raised a blocking check-out checklist', `room=${roomRow?.status}, blocking=${blocking.length}`);
    // Check-out flips the room to CLEANING → the ROOM_CLEANING status checklist (non-blocking).
    const rcJobs = (await jobsFor(roomId, 'ROOM_CLEANING')).filter(j => created.templates.includes(j.template_id));
    ok(rcJobs.length >= 1, 'E2E-ROOM-CLEANING', 'Check-out raised the ROOM_CLEANING status checklist (non-blocking)', `${rcJobs.length} cleaning job(s)`);

    // Gating — completing the blocking checklist releases the room to VACANT.
    for (const j of blocking) await closeJob(j.id);
    const roomRow2 = asList((await api('GET', `${P}/hotel/rooms`)).data).find(x => x.id === roomId);
    ok(roomRow2?.status === 'VACANT', 'E2E-GATING', 'Completing the blocking checklist released the room to VACANT', `room=${roomRow2?.status}`);

    // ── OWNER OPT-OUT: checklist_validate_on_checkout = 0 ──
    // The check-out checklist is still RAISED (housekeeping visibility) but forced
    // NON-blocking, so the room is never held. Round-trips the new owner setting.
    const st1 = await api('GET', `${P}/hotel/settings`);
    if (st1.status === 200 && st1.data && 'checklist_validate_on_checkout' in st1.data) {
      created.restoreCheckoutValidate = st1.data.checklist_validate_on_checkout;
      await api('PATCH', `${P}/hotel/settings`, { checklist_validate_on_checkout: false });
      const st2 = await api('GET', `${P}/hotel/settings`);
      ok(st2.data?.checklist_validate_on_checkout === false, 'E2E-CO-SETTING', 'checklist_validate_on_checkout round-trips to false', `got=${st2.data?.checklist_validate_on_checkout}`);

      let bId2 = null, rId2 = null;
      for (const room of rooms.slice(0, 8)) {
        if (room.id === roomId) continue;
        const bk = await api('POST', `${P}/hotel/bookings`, { room_id: room.id, guest_name: `E2E Guest ${tag}b`, guest_phone: '9990000124', num_guests: 1, check_in_date: day(0), check_out_date: day(2), booking_source: 'DIRECT', room_rate: Number(room.base_price || 1500) });
        if (bk.status === 201 && bk.data?.id) { bId2 = bk.data.id; rId2 = room.id; break; }
      }
      if (bId2) {
        created.bookingId2 = bId2;
        await api('POST', `${P}/hotel/bookings/${bId2}/checkin`, {});
        const co2 = await api('POST', `${P}/hotel/bookings/${bId2}/checkout`, { payment_method: 'CASH', waive: true });
        if (co2.status === 200 || co2.status === 201) {
          const coJobs2 = (await jobsFor(rId2, 'CHECK_OUT')).filter(j => created.templates.includes(j.template_id));
          const anyBlocking = coJobs2.some(j => j.status === 'OPEN' && Number(j.blocks_release) === 1);
          ok(coJobs2.length >= 1 && !anyBlocking, 'E2E-CO-NONBLOCK', 'With validate-on-checkout OFF, the check-out checklist is raised NON-blocking (room not held)', `jobs=${coJobs2.length}, anyBlocking=${anyBlocking}`);
        } else { skip('E2E-CO-NONBLOCK', 'Non-blocking check-out', `check-out failed HTTP ${co2.status}`); }
      } else { skip('E2E-CO-NONBLOCK', 'Non-blocking check-out', 'no second bookable room'); }
    } else {
      skip('E2E-CO-SETTING', 'checkout setting', 'checklist_validate_on_checkout not present — server not updated?');
      skip('E2E-CO-NONBLOCK', 'Non-blocking check-out', 'setting not present');
    }
  } finally {
    console.log('\n… cleaning up test data …');
    await cleanup();
    console.log(`\n═══ ${passN} passed, ${failN} failed, ${skipN} skipped ═══\n`);
  }
  process.exit(failN ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e); try { await cleanup(); } catch {} process.exit(2); });
