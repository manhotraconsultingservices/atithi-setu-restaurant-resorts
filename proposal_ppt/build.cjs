const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const Fa = require("react-icons/fa");

// ---------- Palette (Midnight Executive + warm gold accent for hospitality) ----------
const NAVY   = "1E2761";  // primary
const NAVY2  = "2B3A78";  // lighter navy for cards
const ICE    = "CADCFC";  // ice blue
const GOLD   = "E0A800";  // hospitality gold accent
const WHITE  = "FFFFFF";
const SLATE  = "5B6478";  // muted body
const LIGHT  = "F4F6FB";  // light panel bg
const INK    = "1A1F36";  // dark text

const HFONT = "Georgia";
const BFONT = "Calibri";

// ---------- Icon helper ----------
async function icon(Comp, color, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Comp, { color, size: String(size) })
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}

const makeShadow = () => ({ type: "outer", color: "000000", blur: 8, offset: 3, angle: 135, opacity: 0.18 });

(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.3 x 7.5
  const W = 13.3, H = 7.5;
  pres.author = "Manhotra Consulting Services";
  pres.title = "Atithi-Setu — Platform Proposal";

  // Pre-render icons
  const icMenu     = await icon(Fa.FaUtensils, "#" + NAVY);
  const icQr       = await icon(Fa.FaQrcode, "#" + NAVY);
  const icKitchen  = await icon(Fa.FaFire, "#" + NAVY);
  const icChart    = await icon(Fa.FaChartLine, "#" + NAVY);
  const icBill     = await icon(Fa.FaFileInvoiceDollar, "#" + NAVY);
  const icHotel    = await icon(Fa.FaHotel, "#" + NAVY);
  const icBox      = await icon(Fa.FaBoxes, "#" + NAVY);
  const icShield   = await icon(Fa.FaShieldAlt, "#" + NAVY);
  const icBell     = await icon(Fa.FaBell, "#" + NAVY);
  const icGlobe    = await icon(Fa.FaGlobe, "#" + NAVY);

  const icCheckG   = await icon(Fa.FaCheckCircle, "#" + GOLD);
  const icCalGold  = await icon(Fa.FaCalendarCheck, "#" + GOLD);
  const icHandshake= await icon(Fa.FaHandshake, "#" + GOLD);
  const icRocket   = await icon(Fa.FaRocket, "#" + GOLD);

  // White icons for dark cards
  const wMenu   = await icon(Fa.FaUtensils, "#" + WHITE);
  const wQr     = await icon(Fa.FaQrcode, "#" + WHITE);
  const wKit    = await icon(Fa.FaFire, "#" + WHITE);
  const wChart  = await icon(Fa.FaChartLine, "#" + WHITE);
  const wHotel  = await icon(Fa.FaHotel, "#" + WHITE);
  const wBox    = await icon(Fa.FaBoxes, "#" + WHITE);

  // ============================================================
  // SLIDE 1 — TITLE (dark)
  // ============================================================
  let s = pres.addSlide();
  s.background = { color: NAVY };
  // subtle motif: gold corner accent block
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.28, h: H, fill: { color: GOLD } });
  s.addText("ATITHI-SETU", {
    x: 0.9, y: 2.05, w: 11.5, h: 1.1, fontFace: HFONT, fontSize: 60, bold: true,
    color: WHITE, charSpacing: 2, margin: 0,
  });
  s.addText("Restaurant + Hospitality Management Platform", {
    x: 0.92, y: 3.15, w: 11.5, h: 0.6, fontFace: BFONT, fontSize: 22, color: ICE, margin: 0,
  });
  s.addText("One platform for QR ordering, live kitchen, GST billing, owner analytics, inventory and a full hotel PMS — built for Indian restaurants and boutique properties.", {
    x: 0.92, y: 3.9, w: 10.8, h: 1.0, fontFace: BFONT, fontSize: 14.5, color: ICE, margin: 0, lineSpacingMultiple: 1.2,
  });
  s.addText("PROJECT PROPOSAL", {
    x: 0.92, y: 6.35, w: 5, h: 0.4, fontFace: BFONT, fontSize: 13, bold: true, color: GOLD, charSpacing: 3, margin: 0,
  });
  s.addText("Prepared by Manhotra Consulting Services", {
    x: 0.92, y: 6.75, w: 7, h: 0.4, fontFace: BFONT, fontSize: 12, color: ICE, margin: 0,
  });

  // ============================================================
  // SLIDE 2 — THE OPPORTUNITY / PROBLEM (light)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText("The Challenge", {
    x: 0.7, y: 0.5, w: 8, h: 0.7, fontFace: HFONT, fontSize: 36, bold: true, color: NAVY, margin: 0,
  });
  s.addText("Small and mid-sized F&B and hospitality businesses juggle disconnected tools.", {
    x: 0.7, y: 1.25, w: 11, h: 0.5, fontFace: BFONT, fontSize: 16, color: SLATE, margin: 0,
  });

  const painPoints = [
    ["Fragmented operations", "Separate POS, billing, kitchen and booking systems that don't talk to each other."],
    ["Billing & GST errors", "Manual invoices, inconsistent GST, and disputes that erode trust and margins."],
    ["No real-time visibility", "Owners fly blind on revenue, occupancy, table status and stock levels."],
    ["Costly enterprise tools", "Cloudbeds / Hotelogix-class software is priced out of reach for boutique players."],
  ];
  let py = 2.05;
  painPoints.forEach((p, i) => {
    const cx = i % 2 === 0 ? 0.7 : 6.85;
    const cy = py + Math.floor(i / 2) * 2.1;
    s.addShape(pres.shapes.RECTANGLE, { x: cx, y: cy, w: 5.75, h: 1.8, fill: { color: LIGHT }, line: { color: ICE, width: 1 }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: cx, y: cy, w: 0.1, h: 1.8, fill: { color: GOLD } });
    s.addText(p[0], { x: cx + 0.35, y: cy + 0.28, w: 5.2, h: 0.5, fontFace: BFONT, fontSize: 18, bold: true, color: NAVY, margin: 0 });
    s.addText(p[1], { x: cx + 0.35, y: cy + 0.82, w: 5.2, h: 0.85, fontFace: BFONT, fontSize: 13.5, color: SLATE, margin: 0, lineSpacingMultiple: 1.1 });
  });

  // ============================================================
  // SLIDE 3 — THE SOLUTION OVERVIEW (dark)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.28, h: H, fill: { color: GOLD } });
  s.addText("One Platform, End to End", {
    x: 0.9, y: 0.5, w: 11.5, h: 0.7, fontFace: HFONT, fontSize: 34, bold: true, color: WHITE, margin: 0,
  });
  s.addText("Atithi-Setu unifies the entire guest and back-office journey in a single multi-tenant system.", {
    x: 0.92, y: 1.25, w: 11, h: 0.5, fontFace: BFONT, fontSize: 15, color: ICE, margin: 0,
  });

  const solCards = [
    [wMenu, "Smart Menu & QR Ordering", "App-less mobile ordering, per-table QR, postpaid multi-round sessions."],
    [wKit, "Live Kitchen Display", "Real-time tickets, ETA, chef assignment, FIFO queue, pickup alerts."],
    [wChart, "360 Owner Analytics", "Revenue, orders, peak hours, payment split, GST — export to CSV/Excel/PDF."],
    [wHotel, "Full Hotel PMS", "Bookings, folios, rate plans, yield, Form-C, OTA channel manager."],
    [wBox, "Inventory Control", "Recipe-based auto-deduction, procurement, forecasting, auto-PO."],
    [wQr, "GST-Ready Billing", "Configurable GST, multi-payment (Cash/Card/UPI), owner-set invoice numbering."],
  ];
  solCards.forEach((c, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = 0.9 + col * 4.05;
    const cy = 2.05 + row * 2.35;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: cy, w: 3.8, h: 2.1, fill: { color: NAVY2 }, rectRadius: 0.08, shadow: makeShadow() });
    s.addShape(pres.shapes.OVAL, { x: cx + 0.3, y: cy + 0.28, w: 0.7, h: 0.7, fill: { color: GOLD, transparency: 78 } });
    s.addImage({ data: c[0], x: cx + 0.42, y: cy + 0.4, w: 0.46, h: 0.46 });
    s.addText(c[1], { x: cx + 0.3, y: cy + 1.05, w: 3.3, h: 0.5, fontFace: BFONT, fontSize: 15, bold: true, color: WHITE, margin: 0 });
    s.addText(c[2], { x: cx + 0.3, y: cy + 1.45, w: 3.35, h: 0.6, fontFace: BFONT, fontSize: 11.5, color: ICE, margin: 0, lineSpacingMultiple: 1.05 });
  });

  // ============================================================
  // SLIDE 4 — KEY MODULES / FEATURE DEPTH (light, icon rows)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText("Capability Highlights", {
    x: 0.7, y: 0.5, w: 9, h: 0.7, fontFace: HFONT, fontSize: 34, bold: true, color: NAVY, margin: 0,
  });

  const feats = [
    [icQr, "Frictionless guest ordering", "Scan-to-order, consolidated postpaid bills, idempotent request-bill, customer-facing GST breakdown."],
    [icChart, "Command-center monitoring", "Real-time table monitor with live stats, bill alerts, waiter assignment and 30s auto-refresh."],
    [icBill, "Owner-configurable invoicing", "Random or sequential numbering, per-tenant prefix, yearly reset — one continuous counter across all invoice types."],
    [icHotel, "Hotel PMS at parity", "Availability calendar, rate plans, yield rules, online check-in, direct-booking page, OTA channel manager (iCal + webhook)."],
    [icBox, "Inventory intelligence", "Auto-deduction on each order, day-of-week forecasting, automatic draft POs, wastage and physical counts."],
    [icShield, "Multi-tenant security", "PostgreSQL schema isolation per restaurant, JWT auth, RBAC across 11 roles, forensic deletion audit."],
  ];
  feats.forEach((f, i) => {
    const fy = 1.5 + i * 0.95;
    s.addShape(pres.shapes.OVAL, { x: 0.7, y: fy, w: 0.62, h: 0.62, fill: { color: LIGHT }, line: { color: ICE, width: 1 } });
    s.addImage({ data: f[0], x: 0.83, y: fy + 0.13, w: 0.36, h: 0.36 });
    s.addText(f[1], { x: 1.55, y: fy - 0.05, w: 4.6, h: 0.45, fontFace: BFONT, fontSize: 16, bold: true, color: NAVY, margin: 0, valign: "middle" });
    s.addText(f[2], { x: 6.3, y: fy - 0.08, w: 6.4, h: 0.8, fontFace: BFONT, fontSize: 12.5, color: SLATE, margin: 0, valign: "middle", lineSpacingMultiple: 1.05 });
  });

  // ============================================================
  // SLIDE 5 — DELIVERY APPROACH / IMPLEMENTATION TIMELINE (light)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText("Delivery Approach", {
    x: 0.7, y: 0.5, w: 9, h: 0.7, fontFace: HFONT, fontSize: 34, bold: true, color: NAVY, margin: 0,
  });
  s.addText("A phased rollout that gets you live fast, then layers depth.", {
    x: 0.7, y: 1.25, w: 11, h: 0.5, fontFace: BFONT, fontSize: 15, color: SLATE, margin: 0,
  });

  const phases = [
    ["1", "Discovery & Setup", "Tenant provisioning, menu/room data import, GST & branding config.", "Weeks 1-2"],
    ["2", "Core Go-Live", "QR ordering, KDS, billing and the owner dashboard live in production.", "Weeks 3-5"],
    ["3", "Depth Modules", "Inventory, hotel PMS and channel manager enabled as needed.", "Weeks 6-9"],
    ["4", "Optimise & Scale", "Analytics tuning, staff training, multi-property rollout.", "Ongoing"],
  ];
  const pw = 2.95, gap = 0.25, startX = 0.7, ty = 2.2;
  phases.forEach((ph, i) => {
    const cx = startX + i * (pw + gap);
    s.addShape(pres.shapes.RECTANGLE, { x: cx, y: ty, w: pw, h: 3.4, fill: { color: i % 2 ? NAVY : NAVY2 }, shadow: makeShadow() });
    s.addShape(pres.shapes.OVAL, { x: cx + pw / 2 - 0.45, y: ty - 0.45, w: 0.9, h: 0.9, fill: { color: GOLD }, line: { color: WHITE, width: 2.5 } });
    s.addText(ph[0], { x: cx + pw / 2 - 0.45, y: ty - 0.45, w: 0.9, h: 0.9, fontFace: HFONT, fontSize: 30, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });
    s.addText(ph[1], { x: cx + 0.25, y: ty + 0.75, w: pw - 0.5, h: 0.7, fontFace: BFONT, fontSize: 17, bold: true, color: WHITE, align: "center", margin: 0 });
    s.addText(ph[2], { x: cx + 0.25, y: ty + 1.5, w: pw - 0.5, h: 1.3, fontFace: BFONT, fontSize: 12.5, color: ICE, align: "center", margin: 0, lineSpacingMultiple: 1.15 });
    s.addText(ph[3], { x: cx + 0.25, y: ty + 2.95, w: pw - 0.5, h: 0.4, fontFace: BFONT, fontSize: 13, bold: true, color: GOLD, align: "center", margin: 0 });
  });

  // ============================================================
  // SLIDE 6 — GOVERNANCE: 2 MEETINGS / MONTH (dark, the requested slide)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.28, h: H, fill: { color: GOLD } });
  s.addText("Progress Governance", {
    x: 0.9, y: 0.5, w: 11.5, h: 0.7, fontFace: HFONT, fontSize: 34, bold: true, color: WHITE, margin: 0,
  });
  s.addText("We measure progress with two structured review meetings every month.", {
    x: 0.92, y: 1.25, w: 11, h: 0.5, fontFace: BFONT, fontSize: 16, color: ICE, margin: 0,
  });

  // Big "2" callout
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.9, y: 2.15, w: 3.5, h: 4.4, fill: { color: NAVY2 }, rectRadius: 0.1, shadow: makeShadow() });
  s.addImage({ data: icCalGold, x: 1.95, y: 2.55, w: 1.4, h: 1.4 });
  s.addText("2", { x: 0.9, y: 3.9, w: 3.5, h: 1.4, fontFace: HFONT, fontSize: 110, bold: true, color: GOLD, align: "center", margin: 0 });
  s.addText("meetings per month", { x: 0.9, y: 5.55, w: 3.5, h: 0.5, fontFace: BFONT, fontSize: 17, color: WHITE, align: "center", margin: 0 });

  // Two meeting cards
  const meetings = [
    [icHandshake, "Mid-Month Check-In", [
      "Review sprint progress against the agreed roadmap",
      "Surface and unblock any operational or data issues",
      "Confirm priorities for the second half of the month",
    ]],
    [icCheckG, "End-of-Month Review", [
      "Demo completed features in the live environment",
      "Review KPIs: adoption, uptime, support tickets, value delivered",
      "Sign off deliverables and lock next month's scope",
    ]],
  ];
  meetings.forEach((m, i) => {
    const cx = 4.75;
    const cy = 2.15 + i * 2.3;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: cy, w: 7.65, h: 2.1, fill: { color: NAVY2 }, rectRadius: 0.08, shadow: makeShadow() });
    s.addShape(pres.shapes.OVAL, { x: cx + 0.3, y: cy + 0.35, w: 0.85, h: 0.85, fill: { color: GOLD, transparency: 80 } });
    s.addImage({ data: m[0], x: cx + 0.48, y: cy + 0.52, w: 0.5, h: 0.5 });
    s.addText(m[1], { x: cx + 1.4, y: cy + 0.28, w: 6, h: 0.5, fontFace: BFONT, fontSize: 19, bold: true, color: WHITE, margin: 0 });
    s.addText(
      m[2].map((t, j) => ({ text: t, options: { bullet: { code: "2022", indent: 14 }, color: ICE, breakLine: true, paraSpaceAfter: 3 } })),
      { x: cx + 1.4, y: cy + 0.78, w: 6.05, h: 1.2, fontFace: BFONT, fontSize: 12.5, margin: 0 }
    );
  });

  // ============================================================
  // SLIDE 7 — WHY ATITHI-SETU / DIFFERENTIATORS (light, stat callouts)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText("Why Atithi-Setu", {
    x: 0.7, y: 0.5, w: 9, h: 0.7, fontFace: HFONT, fontSize: 34, bold: true, color: NAVY, margin: 0,
  });

  const stats = [
    ["1", "platform", "Restaurant POS and hotel PMS unified — no integration tax."],
    ["11", "user roles", "Owner, manager, chef, waiter, front desk, housekeeping and more."],
    ["3", "invoice flows", "QR postpaid, manual and prepaid — all reconciled to one GST-correct total."],
    ["100%", "multi-tenant", "Schema-isolated tenants with JWT auth and forensic audit trails."],
  ];
  stats.forEach((st, i) => {
    const cx = 0.7 + i * 3.1;
    s.addShape(pres.shapes.RECTANGLE, { x: cx, y: 1.7, w: 2.85, h: 2.4, fill: { color: LIGHT }, line: { color: ICE, width: 1 }, shadow: makeShadow() });
    s.addText(st[0], { x: cx, y: 1.85, w: 2.85, h: 1.0, fontFace: HFONT, fontSize: 54, bold: true, color: NAVY, align: "center", margin: 0 });
    s.addText(st[1], { x: cx, y: 2.85, w: 2.85, h: 0.4, fontFace: BFONT, fontSize: 14, bold: true, color: GOLD, align: "center", margin: 0 });
    s.addText(st[2], { x: cx + 0.2, y: 3.25, w: 2.45, h: 0.8, fontFace: BFONT, fontSize: 11.5, color: SLATE, align: "center", margin: 0, lineSpacingMultiple: 1.05 });
  });

  // Closing differentiator band
  s.addShape(pres.shapes.RECTANGLE, { x: 0.7, y: 4.55, w: 11.9, h: 2.1, fill: { color: NAVY } });
  s.addImage({ data: icRocket, x: 1.15, y: 5.05, w: 1.0, h: 1.0 });
  s.addText("Built for Indian F&B and boutique hospitality.", {
    x: 2.55, y: 4.95, w: 9.5, h: 0.6, fontFace: BFONT, fontSize: 20, bold: true, color: WHITE, margin: 0, valign: "middle",
  });
  s.addText("GST-native, UPI-ready, FRRO/Form-C compliant, and priced for properties enterprise tools ignore.", {
    x: 2.55, y: 5.6, w: 9.5, h: 0.8, fontFace: BFONT, fontSize: 14, color: ICE, margin: 0, valign: "middle", lineSpacingMultiple: 1.15,
  });

  // ============================================================
  // SLIDE 8 — NEXT STEPS / CLOSING (dark)
  // ============================================================
  s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.28, h: H, fill: { color: GOLD } });
  s.addText("Next Steps", {
    x: 0.9, y: 0.6, w: 11.5, h: 0.8, fontFace: HFONT, fontSize: 40, bold: true, color: WHITE, margin: 0,
  });

  const steps = [
    ["Approve this proposal", "Confirm scope, timeline and the two-meeting cadence."],
    ["Kick off discovery", "Provision your tenant and import menu / room data."],
    ["Go live in weeks", "Launch core ordering and billing, then layer depth modules."],
  ];
  steps.forEach((st, i) => {
    const sy = 1.9 + i * 1.25;
    s.addShape(pres.shapes.OVAL, { x: 0.95, y: sy, w: 0.75, h: 0.75, fill: { color: GOLD } });
    s.addText(String(i + 1), { x: 0.95, y: sy, w: 0.75, h: 0.75, fontFace: HFONT, fontSize: 26, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 });
    s.addText(st[0], { x: 1.95, y: sy - 0.05, w: 9.5, h: 0.5, fontFace: BFONT, fontSize: 20, bold: true, color: WHITE, margin: 0 });
    s.addText(st[1], { x: 1.95, y: sy + 0.42, w: 9.5, h: 0.5, fontFace: BFONT, fontSize: 14, color: ICE, margin: 0 });
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0.9, y: 6.1, w: 11.5, h: 0.02, fill: { color: ICE } });
  s.addText("Let's build it together.", {
    x: 0.9, y: 6.3, w: 7, h: 0.5, fontFace: HFONT, fontSize: 22, italic: true, bold: true, color: GOLD, margin: 0,
  });
  s.addText("Manhotra Consulting Services  •  atithi-setu.com", {
    x: 0.9, y: 6.85, w: 11.5, h: 0.4, fontFace: BFONT, fontSize: 12.5, color: ICE, margin: 0,
  });

  await pres.writeFile({ fileName: "Atithi-Setu-Proposal.pptx" });
  console.log("WROTE Atithi-Setu-Proposal.pptx");
})();
