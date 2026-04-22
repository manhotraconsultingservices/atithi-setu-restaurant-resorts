'use strict';
const fs = require('fs');
const path = require('path');

// Find docx in global node_modules
const globalNm = require('child_process').execSync('npm root -g').toString().trim();
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, LevelFormat,
  ExternalHyperlink, TableOfContents
} = require(path.join(globalNm, 'docx'));

// ── Brand colours ────────────────────────────────────────────────────────────
const ORANGE   = 'E8721C';
const DARK     = '1A1A1A';
const WHITE    = 'FFFFFF';
const LIGHT_BG = 'FFF8F2';
const GREY_TXT = '555555';
const ORANGE_LIGHT = 'FDE8D4';

// ── Helpers ──────────────────────────────────────────────────────────────────
const cell_border = { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' };
const all_borders = { top: cell_border, bottom: cell_border, left: cell_border, right: cell_border };

function spacer(pts = 120) {
  return new Paragraph({ children: [], spacing: { before: pts, after: 0 } });
}

function hrLine(color = ORANGE, size = 8) {
  return new Paragraph({
    children: [],
    border: { bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } },
    spacing: { before: 0, after: 0 },
  });
}

function coverTitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 120 },
    children: [new TextRun({ text, font: 'Arial', size: 88, bold: true, color: WHITE })],
  });
}

function coverSubtitle(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 200 },
    children: [new TextRun({ text, font: 'Arial', size: 40, color: ORANGE_LIGHT, bold: false })],
  });
}

function coverTagline(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 200 },
    children: [new TextRun({ text, font: 'Georgia', size: 28, color: WHITE, italics: true })],
  });
}

function coverInfo(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 80, after: 0 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: ORANGE_LIGHT })],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160 },
    children: [new TextRun({ text, font: 'Arial', size: 40, bold: true, color: DARK })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ORANGE, space: 6 } },
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 120 },
    children: [new TextRun({ text, font: 'Arial', size: 28, bold: true, color: ORANGE })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 24, bold: true, color: DARK })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: GREY_TXT, ...opts })],
  });
}

function bold_body(text) {
  return body(text, { bold: true, color: DARK });
}

function bullet(label, desc) {
  const children = [];
  if (label && desc) {
    children.push(new TextRun({ text: label + ': ', font: 'Arial', size: 22, bold: true, color: DARK }));
    children.push(new TextRun({ text: desc, font: 'Arial', size: 22, color: GREY_TXT }));
  } else {
    children.push(new TextRun({ text: label || desc, font: 'Arial', size: 22, color: GREY_TXT }));
  }
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { before: 60, after: 60 },
    children,
  });
}

function numbered(text) {
  return new Paragraph({
    numbering: { reference: 'steps', level: 0 },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: GREY_TXT })],
  });
}

function callout(text) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE },
      left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE },
      right: { style: BorderStyle.NIL },
      insideH: { style: BorderStyle.NIL },
      insideV: { style: BorderStyle.NIL },
    },
    rows: [new TableRow({
      children: [new TableCell({
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE },
          left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE },
          right: { style: BorderStyle.NIL },
        },
        shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 200, right: 200 },
        width: { size: 9360, type: WidthType.DXA },
        children: [new Paragraph({
          children: [new TextRun({ text, font: 'Arial', size: 22, color: DARK, italics: true })],
          spacing: { before: 0, after: 0 },
        })],
      })],
    })],
  });
}

function rolesTable() {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Role', 'Access Level', 'Description'].map((h, i) => new TableCell({
      borders: all_borders,
      shading: { fill: ORANGE, type: ShadingType.CLEAR },
      margins: { top: 100, bottom: 100, left: 150, right: 150 },
      width: { size: [1400, 1600, 6360][i], type: WidthType.DXA },
      children: [new Paragraph({
        children: [new TextRun({ text: h, font: 'Arial', size: 22, bold: true, color: WHITE })],
        spacing: { before: 0, after: 0 },
      })],
    })),
  });

  const rows = [
    ['OWNER',    'Full Access',      'All dashboards, settings, analytics, staff management, and billing'],
    ['MANAGER',  'Full Access',      'Same access as Owner; displayed with a purple theme in the staff directory'],
    ['CHEF',     'Kitchen Only',     'Views and marks order status on the Kitchen Display System (KDS)'],
    ['WAITER',   'Table-Specific',   'Sees live table assignments and orders for their own assigned tables'],
    ['CUSTOMER', 'Menu & Orders',    'App-less QR scan — browse the menu, add to cart, and request the bill'],
  ];

  const dataRows = rows.map((r, ri) => new TableRow({
    children: r.map((cell, ci) => new TableCell({
      borders: all_borders,
      shading: { fill: ri % 2 === 0 ? WHITE : LIGHT_BG, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 150, right: 150 },
      width: { size: [1400, 1600, 6360][ci], type: WidthType.DXA },
      children: [new Paragraph({
        children: [new TextRun({
          text: cell, font: 'Arial', size: 20,
          bold: ci === 0, color: ci === 0 ? ORANGE : GREY_TXT,
        })],
        spacing: { before: 0, after: 0 },
      })],
    })),
  }));

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1400, 1600, 6360],
    rows: [headerRow, ...dataRows],
  });
}

function techTable() {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Layer', 'Technology', 'Benefit'].map((h, i) => new TableCell({
      borders: all_borders,
      shading: { fill: DARK, type: ShadingType.CLEAR },
      margins: { top: 100, bottom: 100, left: 150, right: 150 },
      width: { size: [2000, 3000, 4360][i], type: WidthType.DXA },
      children: [new Paragraph({
        children: [new TextRun({ text: h, font: 'Arial', size: 22, bold: true, color: WHITE })],
        spacing: { before: 0, after: 0 },
      })],
    })),
  });

  const rows = [
    ['Frontend',    'React 19 + Vite + Tailwind CSS', 'Lightning-fast, mobile-first, zero lag'],
    ['Backend',     'Node.js + Express + TypeScript',  'Type-safe, reliable, maintainable'],
    ['Database',    'PostgreSQL (Schema Isolation)',    'Enterprise-grade, per-restaurant privacy'],
    ['Real-Time',   'WebSocket Connections',            'Live updates — no refresh needed'],
    ['Deployment',  'Docker Containers',                'Consistent, portable, easy to scale'],
    ['AI',          'Google Gemini AI',                 'Auto-generate food images for menu items'],
    ['QR Codes',    'Dynamic per-table generation',     'Unique codes, always up to date'],
    ['Analytics',   'Recharts',                         'Interactive, visual business insights'],
  ];

  const dataRows = rows.map((r, ri) => new TableRow({
    children: r.map((cell, ci) => new TableCell({
      borders: all_borders,
      shading: { fill: ri % 2 === 0 ? WHITE : LIGHT_BG, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 150, right: 150 },
      width: { size: [2000, 3000, 4360][ci], type: WidthType.DXA },
      children: [new Paragraph({
        children: [new TextRun({
          text: cell, font: 'Arial', size: 20,
          bold: ci === 0, color: ci === 0 ? DARK : GREY_TXT,
        })],
        spacing: { before: 0, after: 0 },
      })],
    })),
  }));

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2000, 3000, 4360],
    rows: [headerRow, ...dataRows],
  });
}

// ── Footer ───────────────────────────────────────────────────────────────────
const pageFooter = new Footer({
  children: [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
      children: [
        new TextRun({ text: 'AtithiSetu\u2122 is a trademark of Manhotra Consulting Services  |  products@manhotraconsulting.in  |  atithi-setu.com  |  Page ', font: 'Arial', size: 16, color: GREY_TXT }),
        new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: GREY_TXT }),
        new TextRun({ text: '  |  \u00A9 2026 Manhotra Consulting Services. All rights reserved.', font: 'Arial', size: 16, color: GREY_TXT }),
      ],
    }),
  ],
});

// ── Cover page header (no footer on cover) ───────────────────────────────────
const coverHeader = new Header({ children: [new Paragraph({ children: [] })] });
const coverFooter = new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: '\u00A9 2026 Manhotra Consulting Services. All rights reserved.', font: 'Arial', size: 16, color: '999999' })],
  })],
});

// ── Document ─────────────────────────────────────────────────────────────────
const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 560, hanging: 280 } } } }],
      },
      {
        reference: 'steps',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 560, hanging: 280 } } } }],
      },
    ],
  },
  styles: {
    default: { document: { run: { font: 'Arial', size: 22, color: GREY_TXT } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 40, bold: true, font: 'Arial', color: DARK },
        paragraph: { spacing: { before: 400, after: 160 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: ORANGE },
        paragraph: { spacing: { before: 300, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, font: 'Arial', color: DARK },
        paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
    ],
  },

  sections: [
    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION A — COVER PAGE (dark orange background effect via shading table)
    // ═══════════════════════════════════════════════════════════════════════════
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: { default: coverHeader },
      footers: { default: coverFooter },
      children: [
        // Orange banner block
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [9360],
          borders: { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL }, insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL } },
          rows: [new TableRow({
            children: [new TableCell({
              borders: { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL } },
              shading: { fill: ORANGE, type: ShadingType.CLEAR },
              margins: { top: 2000, bottom: 2000, left: 600, right: 600 },
              width: { size: 9360, type: WidthType.DXA },
              children: [
                coverTitle('AtithiSetu\u2122'),
                coverSubtitle('Restaurant Management Platform'),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 160, after: 200 },
                  children: [new TextRun({ text: '\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015', font: 'Arial', size: 22, color: ORANGE_LIGHT })],
                }),
                coverTagline('From Table to Kitchen. From Kitchen to Customer. All Connected.'),
              ],
            })],
          })],
        }),

        spacer(400),

        // Version / company block
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [9360],
          borders: { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL }, insideH: { style: BorderStyle.NIL }, insideV: { style: BorderStyle.NIL } },
          rows: [new TableRow({
            children: [new TableCell({
              borders: { top: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL } },
              shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
              margins: { top: 300, bottom: 300, left: 400, right: 400 },
              width: { size: 9360, type: WidthType.DXA },
              children: [
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 80 },
                  children: [new TextRun({ text: 'Version 1.0  |  April 2026', font: 'Arial', size: 24, bold: true, color: DARK })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 80 },
                  children: [new TextRun({ text: 'Manhotra Consulting Services', font: 'Arial', size: 24, bold: true, color: ORANGE })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 80 },
                  children: [new TextRun({ text: 'products@manhotraconsulting.in  |  atithi-setu.com', font: 'Arial', size: 20, color: GREY_TXT })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 0 },
                  children: [new TextRun({ text: 'AtithiSetu\u2122 is a trademark brand of Manhotra Consulting, founded by Ankush Manhotra', font: 'Arial', size: 18, italics: true, color: GREY_TXT })] }),
              ],
            })],
          })],
        }),

        spacer(400),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION B — TABLE OF CONTENTS
    // ═══════════════════════════════════════════════════════════════════════════
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: { default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
          children: [new TextRun({ text: 'AtithiSetu\u2122 User Manual', font: 'Arial', size: 18, color: GREY_TXT })] }),
      ]}) },
      footers: { default: pageFooter },
      children: [
        h1('Table of Contents'),
        spacer(120),
        new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-2' }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION C — MAIN CONTENT
    // ═══════════════════════════════════════════════════════════════════════════
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: { default: new Header({ children: [
        new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ORANGE, space: 4 } },
          children: [new TextRun({ text: 'AtithiSetu\u2122 User Manual  |  Manhotra Consulting Services', font: 'Arial', size: 18, color: GREY_TXT })] }),
      ]}) },
      footers: { default: pageFooter },
      children: [

        // ── Section 1: About AtithiSetu ─────────────────────────────────────
        h1('1.  About AtithiSetu\u2122'),
        body('AtithiSetu (meaning \u201cGuest Bridge\u201d in Sanskrit) is a comprehensive, cloud-based restaurant management ecosystem built for the modern food and beverage industry. Developed by Manhotra Consulting Services \u2014 a Gurugram-based technology consultancy specialising in AI automation and enterprise software \u2014 AtithiSetu\u2122 bridges the gap between restaurant owners, kitchen staff, and customers in real time.'),
        spacer(80),
        body('AtithiSetu\u2122 is a trademark brand of Manhotra Consulting, founded by Ankush Manhotra \u2014 a seasoned technology leader with 16+ years of experience in Product Lifecycle Management, SaaS Development, and Enterprise Software. Ankush holds a degree in Computer Science Engineering from Guru Nanak Dev University and brings global consulting experience across India, the United States, and beyond.'),
        spacer(160),
        h2('About Manhotra Consulting Services'),
        body('Manhotra Consulting Services is an IT consulting and SaaS development firm headquartered at Sector 57, Gurugram, Haryana 122001, India. The firm specialises in:'),
        bullet('AI Automation & Growth Systems', 'Intelligent process automation for modern enterprises'),
        bullet('SaaS Product Development', 'End-to-end development of cloud-based software products'),
        bullet('Business Analytics', 'Data-driven insights and dashboards for decision-makers'),
        bullet('Cloud Application Development', 'Scalable, cloud-native applications built for performance'),
        bullet('Management Consulting', 'Strategy, process, and technology advisory services'),
        spacer(120),
        body('Current product portfolio includes:'),
        bullet('AtithiSetu\u2122', 'Restaurant management and customer ordering platform'),
        bullet('Prabandh', 'Manufacturing command centre dashboard for MSMEs in pharma, nutraceuticals, and chemicals'),
        bullet('PLM Pundits', 'Product Lifecycle Management knowledge and training platform'),
        spacer(120),
        callout('Contact us: products@manhotraconsulting.in  |  Website: atithi-setu.com  |  LinkedIn: linkedin.com/in/ankushmanhotra'),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 2: Who Is This For? ─────────────────────────────────────
        h1('2.  Who Is AtithiSetu\u2122 For?'),
        body('AtithiSetu\u2122 is designed for a wide spectrum of food service businesses \u2014 from single-table street-side kiosks to multi-outlet food courts. If your business takes orders, serves food, and collects payments, AtithiSetu\u2122 is built for you.'),
        spacer(120),
        bullet('Quick-Service Kiosks & Food Carts', 'Streamline rapid ordering, billing, and payment collection with zero friction'),
        bullet('Casual Dining & Family Restaurants', 'Full table management, postpaid session flow, and real-time kitchen coordination'),
        bullet('Specialty Coffee Shops & Caf\u00E9s', 'Half/full pricing, item availability toggles, and daily specials management'),
        bullet('Food Courts & Multi-Vendor Hubs', 'Multi-tenant architecture supports multiple outlets within a shared infrastructure'),
        bullet('Dark Kitchens & Delivery-Only Outlets', 'KDS and order tracking without any front-of-house requirements'),
        spacer(200),
        callout('Whether you serve 20 covers a day or 2,000, AtithiSetu\u2122 scales with your business \u2014 no hardware required, no app download for your customers.'),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 3: Key Features ─────────────────────────────────────────
        h1('3.  Key Features'),

        h2('3.1  Smart Menu Management'),
        body('Build, manage, and update your digital menu with complete control. No technical expertise required.'),
        bullet('Dynamic Pricing', 'Set independent half-portion and full-portion prices for every menu item'),
        bullet('Dietary Markers', 'Tag each item as Vegetarian, Non-Vegetarian, or Vegan with clear visual icons'),
        bullet('Real-Time Availability', 'Toggle individual items on or off instantly; mark items as Daily Specials with one click'),
        bullet('Media', 'Upload high-quality food photographs; images are automatically backed up to Google Drive'),
        bullet('Bulk Import', 'Import hundreds of menu items at once via CSV, including local image files \u2014 entire menus onboarded in minutes'),
        bullet('AI Image Generation', 'No photo? No problem. AtithiSetu\u2122 uses Google Gemini AI to automatically generate professional food imagery for any menu item'),
        spacer(160),

        h2('3.2  QR Code Ordering \u2014 App-Less Customer Experience'),
        body('Your customers order in seconds, straight from their mobile browser. No app download. No account creation. No friction.'),
        bullet('Table-Specific QR Codes', 'Every table has its own unique QR code, generated automatically'),
        bullet('No App Required', 'Customers scan the code and the menu opens instantly in their browser'),
        bullet('Postpaid Session Flow', 'Customers place multiple rounds of orders; all linked to a single running bill'),
        bullet('Multiple Rounds', 'Add more items to the same bill at any time during the visit'),
        bullet('Category & Dietary Filters', 'Customers filter the menu by food category or dietary preference'),
        bullet('Payment Method Selection', 'Customer selects Cash, Card, or UPI before requesting the bill'),
        spacer(160),

        h2('3.3  Live Kitchen Display System (KDS)'),
        body('Every order placed by a customer flows directly to your kitchen screen the moment it is confirmed.'),
        bullet('Live Tickets', 'Orders appear on kitchen displays in real time \u2014 no paper slips, no shouting across the floor'),
        bullet('Elapsed Time Tracking', 'Each ticket shows how long the order has been waiting \u2014 never miss a target time'),
        bullet('One-Tap Updates', 'Chefs mark items as ready; floor staff are instantly notified'),
        bullet('Auto-Clear', 'Once a bill is paid, all associated orders are automatically removed from the KDS'),
        bullet('Manual Invoice Support', 'Walk-in or phone orders added manually are also tracked in the KDS with a clear "Manual" label'),
        spacer(160),

        h2('3.4  Command Center \u2014 Real-Time Table Monitor'),
        body('Your single screen for everything happening on the floor, in real time.'),
        bullet('Live Table Grid', 'Colour-coded cards for every table: Emerald = Available, Amber = Occupied, Rose = Unavailable, Blue = Bill Requested'),
        bullet('Real-Time Metrics Bar', 'Five live counters at a glance: Available, Occupied, N/A, Bill Requests, and Live Revenue'),
        bullet('Urgent Bill Alerts', 'A prominent banner auto-appears whenever any table has a pending bill request \u2014 staff are never left wondering'),
        bullet('Elapsed Session Timers', 'Each occupied table shows exactly how long the guests have been seated, ticking every second'),
        bullet('Waiter Assignment', 'Assign or reassign waiters to any table directly from the monitor without leaving the screen'),
        bullet('30-Second Auto-Refresh', 'The floor plan refreshes automatically every 30 seconds \u2014 always current, no manual reload'),
        bullet('Premium Dark UI', 'A sleek, glassmorphism-style dark interface designed for low-light restaurant environments'),
        spacer(160),

        h2('3.5  GST-Ready Billing'),
        body('Fully compliant invoicing with automated tax calculations \u2014 so you never have to do the maths manually.'),
        bullet('Configurable GST', 'Set your GST percentage per restaurant; toggle on or off as needed'),
        bullet('Automated Calculations', 'GST is computed automatically on every order and invoice'),
        bullet('Status Tracking', 'Monitor Pending vs. Paid invoices across all tables at a glance'),
        bullet('Multi-Payment Support', 'Track Cash, Card, and UPI transactions in one place'),
        bullet('Itemised Invoices', 'Customers receive a full breakdown of every item ordered, with tax displayed clearly'),
        spacer(160),
        new Paragraph({ children: [new PageBreak()] }),

        h2('3.6  360\u00B0 Analytics & Owner Reports'),
        body('Data that helps you make smarter decisions about your menu, staffing, and operations.'),
        bullet('Daily & Weekly Sales Charts', 'Interactive visual trend analysis \u2014 see revenue patterns at a glance'),
        bullet('Top-Performing Items', 'Know exactly which dishes are driving the most revenue'),
        bullet('Peak Hour Analysis', 'Identify your busiest times to staff appropriately and reduce wait times'),
        bullet('Payment Method Breakdown', 'Understand whether your customers prefer cash, card, or UPI'),
        bullet('Category Performance', 'Revenue breakdown by menu category \u2014 starters, mains, drinks, and more'),
        spacer(160),

        h2('3.7  Table Reservations'),
        body('Let your customers plan ahead, and you\u2019ll always be prepared.'),
        bullet('Online Booking Portal', 'Guests book tables in advance from any device \u2014 no phone calls required'),
        bullet('Calendar Management', 'Manage availability by date, day of week, time slot, and maximum covers'),
        bullet('Walk-In Optimisation', 'Spread reservations intelligently to reduce peak-hour queues'),
        spacer(160),

        h2('3.8  Staff & Attendance Management'),
        body('Everything you need to manage your team, in one place.'),
        bullet('Staff Directory', 'Full records for all Chefs, Waiters, and Managers with role-based colour coding'),
        bullet('Role-Based Access Control', 'Each staff member sees only the screens and data relevant to their role'),
        bullet('Attendance Logs', 'Daily check-in and check-out, working hours, and shift type tracking'),
        bullet('Waiter Dashboard', 'Waiters see their assigned tables and live order status \u2014 no ambiguity on the floor'),
        spacer(160),

        h2('3.9  Multi-Channel Notifications'),
        body('Keep your team and customers informed automatically, across every channel they use.'),
        bullet('Channels', 'Email, SMS, and WhatsApp notifications \u2014 no extra apps required'),
        bullet('Configurable Triggers', 'Set specific triggers for new orders, bill requests, and payment confirmations'),
        bullet('Granular Recipients', 'Configure separate notification rules for owners, staff, and customers'),
        spacer(160),

        h2('3.10  Multi-Tenant Security'),
        body('Enterprise-grade data isolation \u2014 every restaurant\u2019s data is completely private.'),
        bullet('Schema Isolation', 'Each restaurant runs in its own isolated PostgreSQL schema within a shared infrastructure'),
        bullet('Zero Data Leakage', 'Absolute guarantee: no restaurant can ever access another\u2019s orders, menus, or customer data'),
        bullet('JWT Authentication', 'Industry-standard token-based security for every user session'),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 4: User Roles ───────────────────────────────────────────
        h1('4.  User Roles & Access Levels'),
        body('AtithiSetu\u2122 uses a role-based access control model. Each user sees only the features and data relevant to their responsibilities, keeping the interface clean and secure.'),
        spacer(160),
        rolesTable(),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 5: Customer Experience ─────────────────────────────────
        h1('5.  The Customer Experience'),
        h2('The Postpaid Session Flow \u2014 Step by Step'),
        body('From the moment a guest sits down to the moment they pay, AtithiSetu\u2122 handles every step automatically.'),
        spacer(120),
        numbered('Customer arrives at their table and scans the QR code with any smartphone camera'),
        numbered('The restaurant\u2019s menu opens instantly in the mobile browser \u2014 no app download, no account required'),
        numbered('Customer browses the full menu, filtering by category (e.g. Mains, Drinks) or dietary preference (Veg, Non-Veg, Vegan)'),
        numbered('Customer adds items to their cart and enters their name and phone number on the first order'),
        numbered('\u201cAdd to Bill\u201d confirms the order and links it to the active table session'),
        numbered('Customer can place additional rounds of orders at any time during their visit \u2014 all added to the same running bill'),
        numbered('When ready to leave, customer taps \u201cRequest Bill\u201d and selects their preferred payment method (Cash, Card, or UPI)'),
        numbered('A full itemised invoice is displayed on the customer\u2019s screen; staff are notified immediately to collect payment'),
        numbered('Owner or Manager marks the session as closed once payment is received \u2014 the table is instantly returned to Available'),
        spacer(200),
        callout('The entire experience requires zero app downloads, zero account creation, and zero friction. Customers are ordering within 10 seconds of scanning the QR code.'),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 6: Technology ───────────────────────────────────────────
        h1('6.  Technology & Reliability'),
        body('AtithiSetu\u2122 is built on a modern, production-grade technology stack designed for speed, reliability, and scale. Every component is chosen for performance and maintainability.'),
        spacer(160),
        techTable(),
        spacer(200),
        callout('AtithiSetu\u2122 is deployed using Docker containers, ensuring that the system runs identically across development, staging, and production environments. Updates are rolled out with zero downtime.'),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 7: Getting Started ──────────────────────────────────────
        h1('7.  Getting Started'),
        h2('Onboarding Your Restaurant'),
        body('Getting your restaurant live on AtithiSetu\u2122 is fast and fully supported. Our team handles the setup so you can focus on your food.'),
        spacer(120),
        numbered('Contact our team at products@manhotraconsulting.in to initiate your onboarding'),
        numbered('We set up your restaurant account, configure your profile, GST settings, and table layout'),
        numbered('Add your menu items \u2014 manually via the dashboard, or bulk import hundreds of items via CSV with images'),
        numbered('Generate unique QR codes for every table \u2014 print them and place them on the tables'),
        numbered('Brief your kitchen team and floor staff on their respective dashboards (5 minutes per role)'),
        numbered('Go live \u2014 your customers can start scanning and ordering immediately'),
        spacer(200),
        h2('Contact & Support'),
        spacer(80),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [2000, 7360],
          borders: { top: { style: BorderStyle.NIL }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL }, insideH: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, insideV: { style: BorderStyle.NIL } },
          rows: [
            ['\uD83D\uDCE7  Email', 'products@manhotraconsulting.in'],
            ['\uD83C\uDF10  Website', 'atithi-setu.com'],
            ['\uD83D\uDCCD  Address', 'Sector 57, Gurugram, Haryana 122001, India'],
            ['\uD83D\uDD17  LinkedIn', 'linkedin.com/in/ankushmanhotra'],
          ].map((r, ri) => new TableRow({
            children: r.map((cell, ci) => new TableCell({
              borders: { top: ri === 0 ? { style: BorderStyle.NIL } : { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, bottom: { style: BorderStyle.NIL }, left: { style: BorderStyle.NIL }, right: { style: BorderStyle.NIL } },
              shading: { fill: ci === 0 ? LIGHT_BG : WHITE, type: ShadingType.CLEAR },
              margins: { top: 120, bottom: 120, left: 200, right: 200 },
              width: { size: [2000, 7360][ci], type: WidthType.DXA },
              children: [new Paragraph({
                children: [new TextRun({ text: cell, font: 'Arial', size: 22, bold: ci === 0, color: ci === 0 ? ORANGE : GREY_TXT })],
                spacing: { before: 0, after: 0 },
              })],
            })),
          })),
        }),
        spacer(300),
        new Paragraph({ children: [new PageBreak()] }),

        // ── Section 8: Why AtithiSetu ───────────────────────────────────────
        h1('8.  Why AtithiSetu\u2122?'),
        body('In a market full of complicated, expensive POS systems, AtithiSetu\u2122 takes a fundamentally different approach. We built it from the ground up to be frictionless \u2014 for customers, for kitchen staff, and for owners alike.'),
        spacer(160),
        h2('Key Differentiators'),
        bullet('Zero hardware required', 'AtithiSetu\u2122 runs entirely on existing smartphones and tablets \u2014 no expensive POS terminals'),
        bullet('No customer app download', 'Your guests order in seconds via a mobile browser. Fewer steps = more orders'),
        bullet('Real-time everywhere', 'WebSocket-powered updates mean orders, status changes, and bill requests are instant across all devices'),
        bullet('Built for India', 'GST-ready, UPI support, multi-language foundation, and designed for the Indian food service market'),
        bullet('Scales from 1 table to 200+', 'The same platform powers a roadside stall and a large dining restaurant'),
        bullet('Multi-tenant by design', 'Each restaurant\u2019s data is completely isolated \u2014 enterprise-grade security at every tier'),
        bullet('Backed by 16+ years of enterprise expertise', 'Built by a team that has delivered technology solutions for global enterprises across multiple industries'),
        spacer(200),
        callout('AtithiSetu\u2122 is not just a POS system. It is a complete restaurant management ecosystem \u2014 from the moment a guest sits down to the moment they walk out, and every business insight in between.'),
        spacer(300),
        hrLine(ORANGE, 4),
        spacer(200),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 80 },
          children: [new TextRun({ text: 'AtithiSetu\u2122', font: 'Arial', size: 36, bold: true, color: ORANGE })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 80 },
          children: [new TextRun({ text: 'A trademark brand of Manhotra Consulting Services', font: 'Arial', size: 22, color: GREY_TXT, italics: true })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 80 },
          children: [new TextRun({ text: 'Founded by Ankush Manhotra', font: 'Arial', size: 22, color: GREY_TXT })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 80 },
          children: [new TextRun({ text: 'products@manhotraconsulting.in  |  atithi-setu.com', font: 'Arial', size: 22, color: ORANGE })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 0 },
          children: [new TextRun({ text: '\u00A9 2026 Manhotra Consulting Services. All rights reserved.', font: 'Arial', size: 18, color: GREY_TXT })],
        }),
      ],
    },
  ],
});

// ── Write file ────────────────────────────────────────────────────────────────
const outPath = 'C:\\Users\\Admin\\Documents\\Workspace_MCS\\dev-erp.athiti-setu\\dev-erp\\AtithiSetu_User_Manual.docx';
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('Written: ' + outPath + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');
}).catch(err => { console.error('ERROR:', err.message); process.exit(1); });
