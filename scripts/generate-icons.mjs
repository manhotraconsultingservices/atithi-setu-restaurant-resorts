/**
 * Generates PWA icons for Atithi Setu from an embedded SVG.
 * Run: node scripts/generate-icons.mjs
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '../public');

// ── Atithi Setu brand icon SVG ───────────────────────────────────────────────
// Inspired by the logo: namaste hands + sun/flame + ocean-arch waves
// in deep navy (#1a3a6e) and warm gold (#d4951a).
// The SVG is drawn in a 512×512 viewBox.

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <!-- Background gradient: deep navy to rich blue -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#0f2547"/>
      <stop offset="100%" stop-color="#1a3a6e"/>
    </linearGradient>
    <!-- Gold gradient for arches and sun -->
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#f5c842"/>
      <stop offset="100%" stop-color="#c97f10"/>
    </linearGradient>
    <!-- Blue gradient for inner arch -->
    <linearGradient id="blueGrad" x1="0%" y1="100%" x2="0%" y2="0%">
      <stop offset="0%"   stop-color="#3b82c4"/>
      <stop offset="100%" stop-color="#6aafe6"/>
    </linearGradient>
    <!-- Glow filter for sun -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="6" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Rounded-square background -->
  <rect width="512" height="512" rx="96" ry="96" fill="url(#bgGrad)"/>

  <!-- ── Sun / flame (top center) ── -->
  <!-- Sun disc -->
  <circle cx="256" cy="148" r="36" fill="url(#goldGrad)" filter="url(#glow)" opacity="0.95"/>
  <!-- Sun rays (8 rays) -->
  <g fill="url(#goldGrad)" filter="url(#glow)" opacity="0.85">
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(0   256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(45  256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(90  256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(135 256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(180 256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(225 256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(270 256 148)"/>
    <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(315 256 148)"/>
  </g>

  <!-- ── Outer gold arch (the sweeping wave) ── -->
  <path d="M 72 360
           C 72 220, 172 160, 256 190
           C 340 160, 440 220, 440 360"
        fill="none" stroke="url(#goldGrad)" stroke-width="28"
        stroke-linecap="round" opacity="0.95"/>

  <!-- ── Inner blue arch ── -->
  <path d="M 118 370
           C 118 258, 196 210, 256 228
           C 316 210, 394 258, 394 370"
        fill="none" stroke="url(#blueGrad)" stroke-width="20"
        stroke-linecap="round" opacity="0.90"/>

  <!-- ── Namaste hands (stylised folded-palm silhouette) ── -->
  <!-- Left palm -->
  <path d="M 256 340
           C 240 316, 220 304, 204 296
           C 188 288, 192 268, 208 272
           C 220 274, 230 284, 240 294
           C 240 276, 228 260, 216 252
           C 204 244, 200 224, 216 224
           C 228 224, 240 240, 248 258
           C 248 244, 240 232, 232 220
           C 224 208, 224 192, 240 196
           C 252 200, 256 220, 256 240
           Z"
        fill="url(#goldGrad)" opacity="0.95"/>
  <!-- Right palm (mirror) -->
  <path d="M 256 340
           C 272 316, 292 304, 308 296
           C 324 288, 320 268, 304 272
           C 292 274, 282 284, 272 294
           C 272 276, 284 260, 296 252
           C 308 244, 312 224, 296 224
           C 284 224, 272 240, 264 258
           C 264 244, 272 232, 280 220
           C 288 208, 288 192, 272 196
           C 260 200, 256 220, 256 240
           Z"
        fill="url(#blueGrad)" opacity="0.95"/>
  <!-- Wrist/join area -->
  <ellipse cx="256" cy="346" rx="22" ry="14" fill="url(#goldGrad)" opacity="0.85"/>

  <!-- ── Bottom wave base ── -->
  <path d="M 72 390 Q 164 370, 256 382 Q 348 394, 440 374 L 440 420 Q 348 440, 256 428 Q 164 416, 72 436 Z"
        fill="url(#blueGrad)" opacity="0.30"/>
</svg>`;

// ── Maskable icon SVG (extra padding so icon fits safe zone) ─────────────────
// Maskable icons need 20% safe zone on each side.
// We embed the same design scaled to 72% and centered.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#0f2547"/>
      <stop offset="100%" stop-color="#1a3a6e"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#f5c842"/>
      <stop offset="100%" stop-color="#c97f10"/>
    </linearGradient>
    <linearGradient id="blueGrad" x1="0%" y1="100%" x2="0%" y2="0%">
      <stop offset="0%"   stop-color="#3b82c4"/>
      <stop offset="100%" stop-color="#6aafe6"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="5" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Full-bleed background (required for maskable) -->
  <rect width="512" height="512" fill="url(#bgGrad)"/>

  <!-- Icon artwork scaled to 72% and centered (safe zone 20% each side = 102.4px) -->
  <g transform="translate(71.68 71.68) scale(0.72)">
    <circle cx="256" cy="148" r="36" fill="url(#goldGrad)" filter="url(#glow)" opacity="0.95"/>
    <g fill="url(#goldGrad)" filter="url(#glow)" opacity="0.85">
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(0   256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(45  256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(90  256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(135 256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(180 256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(225 256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(270 256 148)"/>
      <ellipse cx="256" cy="92"  rx="6" ry="18" transform="rotate(315 256 148)"/>
    </g>
    <path d="M 72 360 C 72 220, 172 160, 256 190 C 340 160, 440 220, 440 360"
          fill="none" stroke="url(#goldGrad)" stroke-width="28" stroke-linecap="round" opacity="0.95"/>
    <path d="M 118 370 C 118 258, 196 210, 256 228 C 316 210, 394 258, 394 370"
          fill="none" stroke="url(#blueGrad)" stroke-width="20" stroke-linecap="round" opacity="0.90"/>
    <path d="M 256 340 C 240 316, 220 304, 204 296 C 188 288, 192 268, 208 272 C 220 274, 230 284, 240 294 C 240 276, 228 260, 216 252 C 204 244, 200 224, 216 224 C 228 224, 240 240, 248 258 C 248 244, 240 232, 232 220 C 224 208, 224 192, 240 196 C 252 200, 256 220, 256 240 Z"
          fill="url(#goldGrad)" opacity="0.95"/>
    <path d="M 256 340 C 272 316, 292 304, 308 296 C 324 288, 320 268, 304 272 C 292 274, 282 284, 272 294 C 272 276, 284 260, 296 252 C 308 244, 312 224, 296 224 C 284 224, 272 240, 264 258 C 264 244, 272 232, 280 220 C 288 208, 288 192, 272 196 C 260 200, 256 220, 256 240 Z"
          fill="url(#blueGrad)" opacity="0.95"/>
    <ellipse cx="256" cy="346" rx="22" ry="14" fill="url(#goldGrad)" opacity="0.85"/>
    <path d="M 72 390 Q 164 370, 256 382 Q 348 394, 440 374 L 440 420 Q 348 440, 256 428 Q 164 416, 72 436 Z"
          fill="url(#blueGrad)" opacity="0.30"/>
  </g>
</svg>`;

// ── Favicon SVG (also written to public/favicon.svg) ─────────────────────────
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f2547"/>
      <stop offset="100%" stop-color="#1a3a6e"/>
    </linearGradient>
    <linearGradient id="gd" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f5c842"/>
      <stop offset="100%" stop-color="#c97f10"/>
    </linearGradient>
    <linearGradient id="bl" x1="0%" y1="100%" x2="0%" y2="0%">
      <stop offset="0%" stop-color="#3b82c4"/>
      <stop offset="100%" stop-color="#6aafe6"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="url(#bg)"/>
  <!-- Sun -->
  <circle cx="32" cy="17" r="5" fill="url(#gd)"/>
  <g stroke="url(#gd)" stroke-width="1.5" stroke-linecap="round">
    <line x1="32" y1="7"  x2="32" y2="10"/>
    <line x1="32" y1="24" x2="32" y2="27"/>
    <line x1="22" y1="17" x2="25" y2="17"/>
    <line x1="39" y1="17" x2="42" y2="17"/>
    <line x1="25" y1="10" x2="27" y2="12"/>
    <line x1="37" y1="22" x2="39" y2="24"/>
    <line x1="39" y1="10" x2="37" y2="12"/>
    <line x1="25" y1="22" x2="27" y2="24"/>
  </g>
  <!-- Gold arch -->
  <path d="M 9 46 C 9 28, 20 22, 32 25 C 44 22, 55 28, 55 46"
        fill="none" stroke="url(#gd)" stroke-width="4" stroke-linecap="round"/>
  <!-- Blue arch -->
  <path d="M 16 48 C 16 34, 24 29, 32 31 C 40 29, 48 34, 48 48"
        fill="none" stroke="url(#bl)" stroke-width="3" stroke-linecap="round"/>
  <!-- Hands -->
  <path d="M 32 43 C 29 38, 25 35, 22 33 C 19 31, 20 27, 23 28 C 26 29, 29 33, 31 36 C 31 31, 28 27, 25 25 C 22 23, 22 19, 25 20 C 28 21, 31 27, 32 31 Z"
        fill="url(#gd)" opacity="0.95"/>
  <path d="M 32 43 C 35 38, 39 35, 42 33 C 45 31, 44 27, 41 28 C 38 29, 35 33, 33 36 C 33 31, 36 27, 39 25 C 42 23, 42 19, 39 20 C 36 21, 33 27, 32 31 Z"
        fill="url(#bl)" opacity="0.95"/>
  <ellipse cx="32" cy="44" rx="3.5" ry="2" fill="url(#gd)" opacity="0.9"/>
</svg>`;

async function generate() {
  console.log('Generating Atithi Setu PWA icons...');

  const iconSvgBuf      = Buffer.from(iconSvg);
  const maskableSvgBuf  = Buffer.from(maskableSvg);
  const faviconSvgBuf   = Buffer.from(faviconSvg);

  // 512×512 icon
  await sharp(iconSvgBuf)
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/icon-512x512.png`);
  console.log('  ✓ icon-512x512.png');

  // 192×192 icon
  await sharp(iconSvgBuf)
    .resize(192, 192)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/icon-192x192.png`);
  console.log('  ✓ icon-192x192.png');

  // 180×180 Apple touch icon
  await sharp(iconSvgBuf)
    .resize(180, 180)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/apple-touch-icon.png`);
  console.log('  ✓ apple-touch-icon.png');

  // 512×512 maskable icon
  await sharp(maskableSvgBuf)
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/maskable-icon.png`);
  console.log('  ✓ maskable-icon.png');

  // 144×144 for MS tiles / old Android
  await sharp(iconSvgBuf)
    .resize(144, 144)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/icon-144x144.png`);
  console.log('  ✓ icon-144x144.png');

  // 96×96
  await sharp(iconSvgBuf)
    .resize(96, 96)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/icon-96x96.png`);
  console.log('  ✓ icon-96x96.png');

  // 72×72 favicon PNG for browsers that don't support SVG favicon
  await sharp(faviconSvgBuf)
    .resize(72, 72)
    .png({ compressionLevel: 9 })
    .toFile(`${publicDir}/favicon-72x72.png`);
  console.log('  ✓ favicon-72x72.png');

  // Write the SVG favicon
  writeFileSync(`${publicDir}/favicon.svg`, faviconSvg);
  console.log('  ✓ favicon.svg');

  console.log('\nAll icons generated successfully!');
}

generate().catch(err => { console.error(err); process.exit(1); });
