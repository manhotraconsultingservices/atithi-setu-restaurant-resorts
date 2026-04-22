'use strict';
const fs   = require('fs');
const path = require('path');
const globalNm = require('child_process').execSync('npm root -g').toString().trim();
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, LevelFormat,
} = require(path.join(globalNm, 'docx'));

const ORANGE      = 'E8721C';
const DARK        = '1A1A1A';
const WHITE       = 'FFFFFF';
const LIGHT_BG    = 'FFF8F2';
const GREY_TXT    = '555555';
const ORANGE_DARK = 'C9592A';
const TEAL        = '0E7490';

const NIL = { style: BorderStyle.NIL };
const no_border = { top: NIL, bottom: NIL, left: NIL, right: NIL, insideH: NIL, insideV: NIL };
const cell_bord = { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' };
const all_bords = { top: cell_bord, bottom: cell_bord, left: cell_bord, right: cell_bord };

// ── Helpers ──────────────────────────────────────────────────────────────────
function sp(pts = 120) { return new Paragraph({ children: [], spacing: { before: pts, after: 0 } }); }

function bigTitle(text, color = WHITE) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 100 },
    children: [new TextRun({ text, font: 'Arial', size: 72, bold: true, color })] });
}
function subTitle(text, color = 'FDE8D4') {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 32, color })] });
}
function tagline(text, color = WHITE) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160, after: 80 },
    children: [new TextRun({ text, font: 'Georgia', size: 26, italics: true, color })] });
}
function sectionHead(text) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 120 },
    children: [new TextRun({ text: text.toUpperCase(), font: 'Arial', size: 30, bold: true, color: ORANGE })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORANGE, space: 8 } } });
}
function body(text, opts = {}) {
  return new Paragraph({ spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: GREY_TXT, ...opts })] });
}
function centreBody(text, opts = {}) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: GREY_TXT, ...opts })] });
}
function bullet(label, desc) {
  const ch = [];
  if (label && desc) {
    ch.push(new TextRun({ text: label + ':  ', font: 'Arial', size: 22, bold: true, color: DARK }));
    ch.push(new TextRun({ text: desc, font: 'Arial', size: 22, color: GREY_TXT }));
  } else {
    ch.push(new TextRun({ text: label, font: 'Arial', size: 22, color: GREY_TXT }));
  }
  return new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { before: 60, after: 60 }, children: ch });
}

// ── Full-width shaded banner table ───────────────────────────────────────────
function banner(children, fill = ORANGE) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA }, columnWidths: [9360],
    borders: no_border,
    rows: [new TableRow({ children: [new TableCell({
      borders: { top: NIL, bottom: NIL, left: NIL, right: NIL },
      shading: { fill, type: ShadingType.CLEAR },
      margins: { top: 400, bottom: 400, left: 500, right: 500 },
      width: { size: 9360, type: WidthType.DXA },
      children,
    })] })],
  });
}

// ── Two-column feature card row ───────────────────────────────────────────────
function featureRow(icon1, title1, desc1, icon2, title2, desc2) {
  const makeCard = (icon, title, desc) => new TableCell({
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: NIL, left: NIL, right: NIL },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    margins: { top: 200, bottom: 200, left: 240, right: 240 },
    width: { size: 4560, type: WidthType.DXA },
    children: [
      new Paragraph({ spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: icon + '  ' + title, font: 'Arial', size: 26, bold: true, color: ORANGE })] }),
      new Paragraph({ spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: desc, font: 'Arial', size: 20, color: GREY_TXT })] }),
    ],
  });
  const spacerCell = new TableCell({
    borders: { top: NIL, bottom: NIL, left: NIL, right: NIL },
    shading: { fill: WHITE, type: ShadingType.CLEAR },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    width: { size: 240, type: WidthType.DXA },
    children: [new Paragraph({ children: [] })],
  });
  return new TableRow({ children: [makeCard(icon1, title1, desc1), spacerCell, makeCard(icon2, title2, desc2)] });
}

// ── Stat highlight box ────────────────────────────────────────────────────────
function statRow(stats) {
  // stats = [{num, label}, ...]
  const w = Math.floor(9360 / stats.length);
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: stats.map(() => w),
    borders: no_border,
    rows: [new TableRow({ children: stats.map((s, i) => new TableCell({
      borders: { top: NIL, bottom: NIL, left: i > 0 ? { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' } : NIL, right: NIL },
      shading: { fill: WHITE, type: ShadingType.CLEAR },
      margins: { top: 200, bottom: 200, left: 120, right: 120 },
      width: { size: w, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 40 },
          children: [new TextRun({ text: s.num, font: 'Arial', size: 56, bold: true, color: ORANGE })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
          children: [new TextRun({ text: s.label, font: 'Arial', size: 18, color: GREY_TXT })] }),
      ],
    })) })],
  });
}

// ── Footer ────────────────────────────────────────────────────────────────────
const pageFooter = new Footer({ children: [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
    children: [
      new TextRun({ text: 'AtithiSetu\u2122  |  products@manhotraconsulting.in  |  atithi-setu.com  |  \u00A9 2026 Manhotra Consulting Services', font: 'Arial', size: 16, color: GREY_TXT }),
    ] }),
] });

// ── Document ──────────────────────────────────────────────────────────────────
const doc = new Document({
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 560, hanging: 280 } } } }] },
    { reference: 'checks', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2713', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 560, hanging: 280 } } } }] },
  ] },
  styles: {
    default: { document: { run: { font: 'Arial', size: 22, color: GREY_TXT } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: DARK },
        paragraph: { spacing: { before: 300, after: 160 }, outlineLevel: 0 } },
    ],
  },

  sections: [
    // ═══════════════════════════════════════════════════════════
    // PAGE 1 — COVER
    // ═══════════════════════════════════════════════════════════
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: new Footer({ children: [
        new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: '\u00A9 2026 Manhotra Consulting Services  |  AtithiSetu\u2122 is a registered trademark', font: 'Arial', size: 16, color: 'AAAAAA' })] }),
      ] }) },
      children: [
        banner([
          bigTitle('AtithiSetu\u2122'),
          subTitle('Restaurant Management Platform'),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 },
            children: [new TextRun({ text: '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015', font: 'Arial', size: 20, color: 'FDE8D4' })] }),
          tagline('From Table to Kitchen. From Kitchen to Customer. All Connected.'),
        ], ORANGE),
        sp(400),
        statRow([
          { num: '10+', label: 'Features Built-In' },
          { num: '5', label: 'User Roles' },
          { num: '0', label: 'App Downloads Needed' },
          { num: '24/7', label: 'Real-Time Updates' },
        ]),
        sp(300),
        new Table({
          width: { size: 9360, type: WidthType.DXA }, columnWidths: [9360],
          borders: no_border,
          rows: [new TableRow({ children: [new TableCell({
            borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, left: NIL, right: NIL },
            shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
            margins: { top: 240, bottom: 240, left: 400, right: 400 },
            width: { size: 9360, type: WidthType.DXA },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
                children: [new TextRun({ text: 'A Product of Manhotra Consulting Services', font: 'Arial', size: 24, bold: true, color: DARK })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
                children: [new TextRun({ text: 'Founded by Ankush Manhotra  |  16+ Years of Enterprise Technology Expertise', font: 'Arial', size: 20, color: GREY_TXT })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
                children: [new TextRun({ text: 'products@manhotraconsulting.in  \u2022  atithi-setu.com  \u2022  Gurugram, India', font: 'Arial', size: 20, color: ORANGE })] }),
            ],
          })] }) ],
        }),
        sp(300),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },

    // ═══════════════════════════════════════════════════════════
    // PAGE 2 — THE PROBLEM & SOLUTION
    // ═══════════════════════════════════════════════════════════
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
          children: [new TextRun({ text: 'AtithiSetu\u2122 by Manhotra Consulting Services', font: 'Arial', size: 18, color: GREY_TXT })] }),
      ] }) },
      footers: { default: pageFooter },
      children: [
        sectionHead('The Challenge Every Restaurant Owner Faces'),
        sp(80),
        body('Running a restaurant has never been more demanding. Customers expect instant service. Kitchen staff need real-time orders. Owners need visibility across every table, every dish, and every rupee \u2014 all at once. Traditional paper systems and expensive POS hardware slow everything down and leave critical gaps.', { size: 24 }),
        sp(200),

        new Table({
          width: { size: 9360, type: WidthType.DXA }, columnWidths: [4560, 240, 4560],
          borders: no_border,
          rows: [
            new TableRow({ children: [
              new TableCell({
                borders: { top: NIL, bottom: NIL, left: { style: BorderStyle.SINGLE, size: 8, color: 'CC3333' }, right: NIL },
                shading: { fill: 'FFF0F0', type: ShadingType.CLEAR },
                margins: { top: 200, bottom: 200, left: 240, right: 240 },
                width: { size: 4560, type: WidthType.DXA },
                children: [
                  new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: '\u274C  Without AtithiSetu\u2122', font: 'Arial', size: 24, bold: true, color: 'CC3333' })] }),
                  ...[
                    'Customers wait to be handed a paper menu',
                    'Orders shouted across the kitchen \u2014 or lost',
                    'Staff unsure which tables need attention',
                    'Manual GST calculations prone to error',
                    'No visibility into best-selling dishes',
                    'Missed bill requests mean frustrated guests',
                    'No data to make smarter business decisions',
                  ].map(t => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { before: 50, after: 50 },
                    children: [new TextRun({ text: t, font: 'Arial', size: 20, color: GREY_TXT })] })),
                ],
              }),
              new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL }, shading: { fill: WHITE, type: ShadingType.CLEAR },
                margins: { top: 0, bottom: 0, left: 0, right: 0 }, width: { size: 240, type: WidthType.DXA },
                children: [new Paragraph({ children: [] })] }),
              new TableCell({
                borders: { top: NIL, bottom: NIL, left: { style: BorderStyle.SINGLE, size: 8, color: '16A34A' }, right: NIL },
                shading: { fill: 'F0FFF4', type: ShadingType.CLEAR },
                margins: { top: 200, bottom: 200, left: 240, right: 240 },
                width: { size: 4560, type: WidthType.DXA },
                children: [
                  new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: '\u2705  With AtithiSetu\u2122', font: 'Arial', size: 24, bold: true, color: '16A34A' })] }),
                  ...[
                    'Customers scan QR and order in seconds',
                    'Orders hit the Kitchen Display instantly',
                    'Command Center shows every table, live',
                    'GST calculated and applied automatically',
                    'Full analytics on top dishes and revenue',
                    'Bill request alerts notify staff immediately',
                    'Daily, weekly, and category reports built in',
                  ].map(t => new Paragraph({ numbering: { reference: 'checks', level: 0 }, spacing: { before: 50, after: 50 },
                    children: [new TextRun({ text: t, font: 'Arial', size: 20, color: GREY_TXT })] })),
                ],
              }),
            ]}),
          ],
        }),
        sp(300),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },

    // ═══════════════════════════════════════════════════════════
    // PAGE 3 — KEY FEATURES
    // ═══════════════════════════════════════════════════════════
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
          children: [new TextRun({ text: 'AtithiSetu\u2122 by Manhotra Consulting Services', font: 'Arial', size: 18, color: GREY_TXT })] }),
      ] }) },
      footers: { default: pageFooter },
      children: [
        sectionHead('Everything Your Restaurant Needs. One Platform.'),
        sp(120),
        new Table({
          width: { size: 9360, type: WidthType.DXA }, columnWidths: [4560, 240, 4560],
          borders: no_border,
          rows: [
            featureRow(
              '\uD83D\uDCCB', 'Smart Menu Management',
              'Dynamic pricing, dietary markers, AI-generated images, bulk CSV import with photos. Your menu, your way.',
              '\uD83D\uDCF1', 'QR Code Ordering',
              'Customers scan, browse, and order instantly. No app. No friction. Orders in under 10 seconds.'
            ),
            new TableRow({ children: [new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL }, shading: { fill: WHITE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 0, left: 0, right: 0 }, width: { size: 9360, type: WidthType.DXA }, children: [new Paragraph({ children: [] })] })] }),
            featureRow(
              '\uD83D\uDCFA', 'Live Kitchen Display (KDS)',
              'Orders flow to kitchen screens the moment they are placed. Elapsed timers. One-tap status updates.',
              '\uD83D\uDEA6', 'Command Center',
              'Real-time table floor plan. Live revenue. Waiter assignment. Bill alert banners. All on one screen.'
            ),
            new TableRow({ children: [new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL }, shading: { fill: WHITE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 0, left: 0, right: 0 }, width: { size: 9360, type: WidthType.DXA }, children: [new Paragraph({ children: [] })] })] }),
            featureRow(
              '\uD83E\uDDFE', 'GST-Ready Billing',
              'Automated GST calculations. Multi-payment tracking (Cash, Card, UPI). Itemised invoices. Fully compliant.',
              '\uD83D\uDCCA', '360\u00B0 Analytics',
              'Top dishes, peak hours, payment trends, category revenue. Data to grow your business intelligently.'
            ),
            new TableRow({ children: [new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL }, shading: { fill: WHITE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 0, left: 0, right: 0 }, width: { size: 9360, type: WidthType.DXA }, children: [new Paragraph({ children: [] })] })] }),
            featureRow(
              '\uD83D\uDCC5', 'Table Reservations',
              'Online booking portal for guests. Calendar management by date, day, and time slot.',
              '\uD83D\uDC65', 'Staff & Attendance',
              'Role-based access, staff directory, daily attendance logs, and waiter assignment dashboard.'
            ),
            new TableRow({ children: [new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL }, shading: { fill: WHITE, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 0, left: 0, right: 0 }, width: { size: 9360, type: WidthType.DXA }, children: [new Paragraph({ children: [] })] })] }),
            featureRow(
              '\uD83D\uDD14', 'Multi-Channel Notifications',
              'Email, SMS, and WhatsApp alerts for orders, bill requests, and payments \u2014 for staff and customers alike.',
              '\uD83D\uDD12', 'Enterprise Security',
              'Per-restaurant PostgreSQL schema isolation. JWT authentication. Zero data leakage between tenants.'
            ),
          ],
        }),
        sp(200),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },

    // ═══════════════════════════════════════════════════════════
    // PAGE 4 — HOW IT WORKS + WHO IT'S FOR + CTA
    // ═══════════════════════════════════════════════════════════
    {
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
          children: [new TextRun({ text: 'AtithiSetu\u2122 by Manhotra Consulting Services', font: 'Arial', size: 18, color: GREY_TXT })] }),
      ] }) },
      footers: { default: pageFooter },
      children: [
        sectionHead('How It Works for Your Customer'),
        sp(80),
        // Steps as a horizontal-ish numbered flow table
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [1800, 120, 1800, 120, 1800, 120, 1800, 120, 1680],
          borders: no_border,
          rows: [new TableRow({ children: [
            ...[
              ['\uD83D\uDCF1', '1. Scan', 'Guest scans the table QR code'],
              ['\uD83D\uDCCB', '2. Browse', 'Menu opens in mobile browser instantly'],
              ['\uD83D\uDED2', '3. Order', 'Add items, confirm with name & phone'],
              ['\uD83C\uDF73', '4. Kitchen', 'Order appears live on KDS screen'],
              ['\uD83E\uDDFE', '5. Pay', 'Request bill, select method, pay'],
            ].flatMap(([icon, step, desc], i, arr) => {
              const cells = [new TableCell({
                borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: NIL, left: NIL, right: NIL },
                shading: { fill: i % 2 === 0 ? LIGHT_BG : 'FFF0E6', type: ShadingType.CLEAR },
                margins: { top: 160, bottom: 160, left: 160, right: 160 },
                width: { size: [1800, 1800, 1800, 1800, 1680][i], type: WidthType.DXA },
                children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
                    children: [new TextRun({ text: icon, font: 'Arial', size: 40 })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 },
                    children: [new TextRun({ text: step, font: 'Arial', size: 22, bold: true, color: ORANGE })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
                    children: [new TextRun({ text: desc, font: 'Arial', size: 18, color: GREY_TXT })] }),
                ],
              })];
              if (i < arr.length - 1) cells.push(new TableCell({ borders: { top: NIL, bottom: NIL, left: NIL, right: NIL },
                shading: { fill: WHITE, type: ShadingType.CLEAR }, margins: { top: 0, bottom: 0, left: 0, right: 0 },
                width: { size: 120, type: WidthType.DXA },
                children: [new Paragraph({ alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: '\u2192', font: 'Arial', size: 32, bold: true, color: ORANGE })] })] }));
              return cells;
            }),
          ] }) ],
        }),

        sp(280),
        sectionHead('Built for Every Food Service Business'),
        sp(100),
        new Table({
          width: { size: 9360, type: WidthType.DXA }, columnWidths: [1820, 1820, 1820, 1820, 1680],
          borders: no_border,
          rows: [new TableRow({ children: [
            ['\uD83C\uDF2E', 'Quick-Service Kiosks & Food Carts'],
            ['\uD83C\uDF7D\uFE0F', 'Casual Dining & Family Restaurants'],
            ['\u2615', 'Coffee Shops & Caf\u00E9s'],
            ['\uD83C\uDFEB', 'Food Courts & Multi-Vendor Hubs'],
            ['\uD83D\uDCE6', 'Dark Kitchens & Delivery Outlets'],
          ].map(([icon, label], i) => new TableCell({
            borders: all_bords,
            shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
            margins: { top: 200, bottom: 200, left: 160, right: 160 },
            width: { size: [1820, 1820, 1820, 1820, 1680][i], type: WidthType.DXA },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
                children: [new TextRun({ text: icon, font: 'Arial', size: 36 })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
                children: [new TextRun({ text: label, font: 'Arial', size: 18, bold: true, color: DARK })] }),
            ],
          })) })],
        }),

        sp(280),
        sectionHead('About the Founder'),
        sp(80),
        new Table({
          width: { size: 9360, type: WidthType.DXA }, columnWidths: [9360], borders: no_border,
          rows: [new TableRow({ children: [new TableCell({
            borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE }, right: NIL },
            shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
            margins: { top: 240, bottom: 240, left: 300, right: 300 },
            width: { size: 9360, type: WidthType.DXA },
            children: [
              new Paragraph({ spacing: { before: 0, after: 80 },
                children: [
                  new TextRun({ text: 'Ankush Manhotra', font: 'Arial', size: 28, bold: true, color: ORANGE }),
                  new TextRun({ text: '  \u2014  Founder, Manhotra Consulting Services', font: 'Arial', size: 22, color: GREY_TXT }),
                ] }),
              new Paragraph({ spacing: { before: 0, after: 80 },
                children: [new TextRun({ text: 'A technology leader with 16+ years of global enterprise experience in Product Lifecycle Management, SaaS Development, and Cloud Application Development. Computer Science Engineering graduate of Guru Nanak Dev University. Consulting experience spanning India, the United States, and beyond. Founder of Manhotra Consulting Services and creator of AtithiSetu\u2122, Prabandh, and PLM Pundits.', font: 'Arial', size: 20, color: GREY_TXT })] }),
              new Paragraph({ spacing: { before: 0, after: 0 },
                children: [new TextRun({ text: '\uD83D\uDD17  linkedin.com/in/ankushmanhotra', font: 'Arial', size: 20, color: ORANGE })] }),
            ],
          })] }) ],
        }),

        sp(280),
        // CTA Banner
        banner([
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
            children: [new TextRun({ text: 'Ready to transform your restaurant?', font: 'Georgia', size: 36, italics: true, color: WHITE })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 120 },
            children: [new TextRun({ text: 'Get in touch today. Onboarding takes less than a day.', font: 'Arial', size: 24, color: 'FDE8D4' })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
            children: [new TextRun({ text: '\uD83D\uDCE7  products@manhotraconsulting.in', font: 'Arial', size: 24, bold: true, color: WHITE })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: '\uD83C\uDF10  atithi-setu.com', font: 'Arial', size: 24, bold: true, color: WHITE })] }),
        ], ORANGE),
      ],
    },
  ],
});

const outPath = 'C:\\Users\\Admin\\Documents\\Workspace_MCS\\dev-erp.athiti-setu\\dev-erp\\AtithiSetu_Brochure.docx';
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('Written: ' + outPath + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');
}).catch(err => { console.error('ERROR:', err.message); process.exit(1); });
