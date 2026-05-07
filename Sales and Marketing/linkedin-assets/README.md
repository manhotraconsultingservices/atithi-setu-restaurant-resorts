# LinkedIn Assets — Atithi-Setu Inventory Module

Three production-ready visual assets for distributing the Inventory module on LinkedIn. Pair any of these with the post copy in `../Inventory_LinkedIn_Posts.md`.

| File | Format | Use |
|---|---|---|
| `01-hero-1200x627.html` | HTML → screenshot | Single image post · LinkedIn link preview |
| `02-carousel-5slides-1080x1080.html` | HTML → PDF | **Highest engagement** — LinkedIn document/carousel post |
| `03-video-storyboard.md` | Markdown spec | Storyboard + voiceover script for a 30-second product video |

---

## 🚀 Quickest path to a published post

### Option A — Hero image only (fastest, ~5 min)

1. Open `01-hero-1200x627.html` in **Chrome**.
2. Press `F12` → toggle device toolbar (`Ctrl+Shift+M` / `Cmd+Shift+M`).
3. Set custom resolution: `1200 × 627`.
4. Right-click the dark canvas → **"Capture node screenshot"** → saves a PNG.
5. Upload that PNG to a LinkedIn post + paste Version 1 copy from `../Inventory_LinkedIn_Posts.md`. Done.

### Option B — Carousel (recommended, ~15 min)

1. Open `02-carousel-5slides-1080x1080.html` in **Chrome**.
2. `Ctrl+P` → Destination: **Save as PDF**.
3. **Important print settings:**
   - Paper size: **Custom** → `1080 × 1080` px (or 28.5 × 28.5 cm)
   - Margins: **None**
   - Background graphics: **ON** (otherwise saffron and dark backgrounds disappear)
   - Pages: All (5)
4. Save as `Inventory_Carousel.pdf`.
5. On LinkedIn, click "+ Document" (paperclip icon in the post composer), upload the PDF. LinkedIn renders it as a swipeable carousel — typically the highest-engagement format on the platform.

### Option C — Video (highest production effort, ~3-4 hours)

Follow `03-video-storyboard.md`:
- Use the included voiceover script verbatim.
- Generate VO via ElevenLabs (free tier covers a 30s clip).
- Capture 4 product screen recordings (specs in the storyboard).
- Edit in CapCut or DaVinci Resolve. Export 1080×1080, 30 fps.

---

## 🎨 Style consistency

All three assets use the same heritage saffron palette as the existing pitch decks:
- **Saffron** `#cc5a16` (primary accent)
- **Saffron-2** `#a84612` (hover/dark)
- **Cream** `#faf7f2` (light bg)
- **Ink** `#14110c` (dark bg / text)
- **Ruby** `#9f1239` (problem/loss callouts)
- **Emerald** `#10b981` (gain/success callouts)
- Type: **Playfair Display** for headlines, **DM Sans** for body

Brand voice across all assets: **direct · numerate · relatable · India-specific**.

---

## 📋 Asset → Post copy pairing matrix

| LinkedIn post variant | Best paired asset | Why |
|---|---|---|
| Version 1 — "Hidden Leak" hook | **Carousel** (5 slides) | Carousel walks through the same 5 leaks visually |
| Version 2 — "Numbers First" | **Hero image** (1200×627) | Hero stat block reinforces the 38%→30% pattern interrupt |
| Version 3 — Customer story (Vivek) | **Video** | Emotional arc benefits from voice + product footage |

---

## 🔁 Re-use & adaptation

These assets are **HTML-based** specifically so the saffron-heritage style is preserved exactly across screenshots, PDFs, and any future export. Edit the `<style>` blocks at the top of each file to:

- **Change the headline figure** (₹40,000 → custom):  search-replace in the body.
- **Re-skin for a sister product** (e.g. Hospitality module): edit the `--saffron` CSS variable and the brand line.
- **Localize**: copy the file, swap copy in any of the 5 slides for Hindi / Marathi / Tamil. The grid layouts are language-agnostic — Devanagari renders cleanly.

---

## 📝 What's NOT included (intentional)

- **No raw PNG / PDF / MP4 binaries** committed to the repo. Why?
  - HTML sources are version-controllable; binary exports aren't (can't diff a PNG)
  - Binaries bloat the repo and lose freshness when copy changes
  - Re-exporting from HTML takes 60 seconds and always reflects the current state
- **No video file** — the storyboard is the spec. Recording is a per-campaign one-off.

If your sales team wants exported binaries permanently archived: export them once via the steps above, store them in your asset DAM (Drive / Notion / Brand folder), not in the code repo.

---

## 📞 Update notes

Generated: 2026-05-07. Inventory module Wave 3 deployment status: **live on dev-erp.atithi-setu.com**. Pitch numbers (₹40k / 8% food cost / 12-15× ROI) reflect current Wave-1-through-3 feature set — re-verify if pitching against tenants on a different module version.
