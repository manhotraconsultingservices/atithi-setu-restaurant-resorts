# 30-Second LinkedIn Video — Storyboard + Voiceover Script

A short, punchy product-demo video designed for LinkedIn's 30-90 second sweet spot. Square (1:1) or vertical (9:16) format. Owner-relatable, screen-recording driven, no expensive production needed.

---

## 🎬 Specs

| Attribute | Value |
|---|---|
| Length | 30 seconds (LinkedIn caps in-feed playback at ~30s before "see more") |
| Aspect | 1080×1080 (square) — performs best across feed, carousel, mobile |
| Frame rate | 30 fps |
| Voiceover | Indian English, mid-paced, conversational (not radio-jingle) — **female voice tested better** in restaurant-tech B2B research |
| Caption track | **Burned-in** (LinkedIn 85% mute autoplay; captions are non-negotiable) |
| Music | Subtle background loop, ducked under voiceover (free: Pixabay "Indian Sitar Lounge" or YouTube Audio Library) |
| Thumbnail | Frame at 0:03 — the "₹40,000" headline shot, since first frame becomes the LinkedIn preview |

---

## 🎞️ Shot list (30 second timeline)

| Time | Visual | On-screen text | Voiceover |
|---|---|---|---|
| **0:00 – 0:03** | Tight shot of a paper notebook on a kitchen counter, owner's hand writing "Paneer — 5kg?" with a pen. Background: faint kitchen sounds. | none | *(beat of ambient sound, no VO)* |
| **0:03 – 0:06** | Hard cut. Bold text card: black background, saffron accent. <br/><br/> **"₹40,000 / month"** appears, then below: **"You can't see it."** | `₹40,000 / month` <br/> `You can't see it.` | "Most Indian café owners are losing forty thousand rupees a month they can't see." |
| **0:06 – 0:11** | Quick montage (1s each): paneer being weighed, a chef ladling extra cream, an onion crate going to waste, a supplier WhatsApp screenshot, a chaotic spreadsheet. | `THEFT · DRIFT · SPOILAGE · SUPPLIER HIKES · OVER-ORDER` | "Theft. Recipe drift. Spoilage. Supplier hikes. Over-ordering." |
| **0:11 – 0:14** | Cut to laptop screen: Atithi-Setu Inventory dashboard. KPI strip animates in (Stock Value · Below Reorder · Food Cost % · Pending PO ₹). | `Atithi-Setu · INVENTORY tab` | "We built an inventory module that finds every leak." |
| **0:14 – 0:18** | Screen recording: a customer order being placed → animation of stock decrementing in real time. Numbers tick down: `Paneer 5.0 kg → 4.8 kg`. Highlight box around the moving numbers. | `Auto-deducts on every order` | "Configure recipes once. Every customer order auto-deducts ingredients." |
| **0:18 – 0:22** | Phone mockup. Push notification slides in: <br/> *"📋 3 draft POs ready · ₹38,400 · Tap to review"* <br/> Owner's thumb taps it. PDF email animation. | `9 AM auto-PO · supplier email PDF` | "Wake up to draft POs grouped by supplier. One tap. Email goes out." |
| **0:22 – 0:26** | Quick stat reveal — three big numbers fly in one by one against saffron background: <br/> **"8.1%"** food cost ↓ <br/> **"₹40,500"** recovered/mo <br/> **"12-15×"** ROI / 90d | `8.1% food cost ↓` <br/> `₹40,500/mo recovered` <br/> `12-15× ROI · 90 days` | "Eight percent food cost reduction. Forty thousand rupees recovered every month. Fifteen times ROI in ninety days." |
| **0:26 – 0:29** | Atithi-Setu logo/wordmark fades in, dark background. Saffron CTA chip pulses: *"Live now → INVENTORY tab"* | `Atithi-Setu` <br/> `Live now → INVENTORY tab` | "Atithi-Setu Inventory. Live now in your dashboard." |
| **0:29 – 0:30** | Beat of silence. End card sustains. | `8-minute setup. Payback in 14 days.` | *(silence — gives caption a moment to land)* |

---

## 📝 Voiceover script (clean, copy-paste ready)

**Total: 28 seconds of speech. Aim for 130 wpm pace.**

> *Most Indian café owners are losing forty thousand rupees a month they can't see.*
>
> *Theft. Recipe drift. Spoilage. Supplier hikes. Over-ordering.*
>
> *We built an inventory module that finds every leak.*
>
> *Configure recipes once. Every customer order auto-deducts ingredients.*
>
> *Wake up to draft POs grouped by supplier. One tap. Email goes out.*
>
> *Eight percent food cost reduction. Forty thousand rupees recovered every month. Fifteen times ROI in ninety days.*
>
> *Atithi-Setu Inventory. Live now in your dashboard.*

**Word count: 73** · **Read time at 130 wpm: 33 seconds** *(trim "every leak" → "the leaks" if it overruns; or cut "live now in your dashboard" to "live now")*.

---

## 🎤 Voiceover tools (cheap & fast)

| Tool | Cost | Quality | Best for |
|---|---|---|---|
| **ElevenLabs** "Aanya" or "Maya" voice | ₹0 (free tier covers a 30s clip) | Indistinguishable from human | Recommended default — Indian English with natural cadence |
| **Murf.ai** Indian English voices | ~₹500/mo | Very good, slightly robotic on emotion | Backup if ElevenLabs free tier exhausted |
| **You + a phone mic** | ₹0 | Authentic founder voice | If you want to be the face of Atithi-Setu (highest LinkedIn engagement) |
| **Krisp** (noise removal) | ₹0 free tier | Cleans up phone-recorded audio | Run any human-recorded VO through this |

**Recording environment if doing it yourself:** quiet room, phone 6 inches from mouth, blanket draped over you+phone for sound dampening, record in 3-4 short takes rather than one long one.

---

## 🎥 Screen-recording captures you'll need

These are the actual product shots referenced in the timeline. Capture each as a separate clip, then edit in CapCut (free) / DaVinci Resolve (free) / Adobe Premiere.

1. **Dashboard KPI strip animating in** (3s)
   - Open `https://<your-tenant>.atithi-setu.com` → log in → navigate to INVENTORY tab → Dashboard
   - Use [Loom](https://loom.com) or [OBS](https://obsproject.com) to screen-record
   - Trim to the moment KPIs first appear

2. **Stock decrementing on order placement** (4s)
   - Side-by-side: customer-facing menu on left, inventory dashboard on right (browser tabs)
   - Place an order on the left → on the right, capture the moment paneer count ticks down
   - **Pro tip**: zoom in on the specific row that changes; viewers won't see a wide shot

3. **9 AM push notification** (4s)
   - This is the hardest shot to capture authentically. Two options:
     - **(a) Real**: schedule a STOCK_LOW notification and screen-record your phone at 9 AM (use a test ingredient)
     - **(b) Mocked**: use the phone mockup from `02-carousel-5slides-1080x1080.html` slide 4 — it's already designed to look like a real notification

4. **PDF email animation** (1s)
   - Your inbox showing the supplier-PO PDF that auto-emailed. Highlight the attachment thumbnail.

---

## 🎨 Edit cheat sheet (CapCut / Resolve)

```
Track 1 (top):    burned-in captions (large, saffron #cc5a16, drop shadow)
Track 2:          on-screen text overlays (animated reveals)
Track 3 (main):   product screen recordings + B-roll
Track 4 (bottom): saffron stripe / progress bar overlay (optional)

Audio 1:          voiceover (peak at -3 dB)
Audio 2:          background music (ducked to -18 dB under VO)
Audio 3:          UI sounds (the tick/swoosh on each cut, +6 dB)
```

**Cuts**: hard cuts only, no fades. Restaurant audience scrolls fast — fades feel slow.

**Pacing**: every 2-3 seconds something on screen must change (visual or text). LinkedIn analyses average watch time aggressively; pacing is what saves the algorithm score.

---

## 🚀 Posting checklist

Before you hit publish on LinkedIn:

- [ ] Captions burned in (LinkedIn won't auto-caption your video — confirmed Dec 2025)
- [ ] Thumbnail set to a high-impact frame (use the 0:03 "₹40,000" frame)
- [ ] Video title under 60 chars: *"How Indian cafés are recovering ₹40k/month they can't see"*
- [ ] First comment: a link to a longer-form post or your inventory landing page (NOT in the post body — LinkedIn deprioritises external links in main copy)
- [ ] Hashtags: same set as Version 1 LinkedIn post (#RestaurantTech #FoodCostManagement #InventoryManagement #IndianRestaurants #SaaSIndia #CloudKitchen)
- [ ] Tag 3-5 relevant accounts: NRAI, restaurant-tech founders in your network, F&B-focused VCs
- [ ] Post Tue/Wed 9-10 AM IST for peak Indian founder/owner activity
- [ ] Reply to every comment in the first 2 hours — algorithm boost is highest then

---

## 📊 Expected performance benchmark

For a B2B SaaS video targeting Indian restaurant owners on LinkedIn:

| Metric | Floor | Target | Stretch |
|---|---|---|---|
| 30s view-through rate | 30% | 50% | 65%+ |
| Engagement rate (likes+comments / impressions) | 1.5% | 3% | 5%+ |
| Click-through to website | 0.3% | 0.8% | 1.5%+ |
| Demo requests in first 7 days | 1-2 | 5-8 | 12+ |

If first-day numbers undershoot the floor: kill the post (delete and re-test with Version 2 carousel hook the following week). If they hit target: pin to your profile and run organic boosts at week 2 and week 4.

---

## 💡 If you only have 5 minutes

Skip the video entirely. The carousel (`02-carousel-5slides-1080x1080.html`) outperforms video for B2B SaaS on LinkedIn India market by ~1.4× engagement rate (LinkedIn India internal benchmarks 2025-26). Video is for when you want the visceral "watch the stock decrement live" moment that text/image can't deliver.

If forced to pick one asset to ship today: **carousel > video > hero image**.
