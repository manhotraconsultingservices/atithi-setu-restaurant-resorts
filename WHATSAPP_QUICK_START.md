# WhatsApp Meta API - Quick Start Checklist

## 🚀 5-Minute Setup Overview

Complete these steps in order to enable WhatsApp notifications.

---

## ☑️ PHASE 1: Get Your Credentials (15 min)

- [ ] Go to https://developers.facebook.com
- [ ] Create/login to Meta Developer Account
- [ ] Create a new **Business** app named "Atithi-Setu WhatsApp"
- [ ] Add **WhatsApp Business Platform** product
- [ ] Create/link your WhatsApp Business Account
- [ ] Verify your phone number: **+91XXXXXXXXXX**
- [ ] Copy these 4 credentials (from API Setup):
  ```
  Phone Number ID:      _____________________
  Business Account ID:  _____________________
  Access Token:         _____________________
  Verify Token:         _____________________
  ```

---

## ☑️ PHASE 2: Configure Webhook (5 min)

In Meta Dashboard WhatsApp Settings:

- [ ] Go to **Configuration**
- [ ] Set **Webhook URL:** `https://your-domain.com/webhook/whatsapp`
  - For local testing: Use ngrok tunnel (see below)
- [ ] Set **Verify Token:** Same as one from Phase 1
- [ ] Select these events to subscribe:
  - ☑ messages
  - ☑ message_status
  - ☑ account_alerts
- [ ] Click **Verify and Save**

**For Local Testing with ngrok:**
```bash
# Install ngrok: https://ngrok.com/download
ngrok http 5001
# Copy the forwarded URL and use in Meta Dashboard
```

---

## ☑️ PHASE 3: Set Environment Variables (3 min)

Create file: `.env.local` in project root

```env
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_id_here
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_VERIFY_TOKEN=your_verify_token_here
```

**⚠️ WARNING:** Never commit `.env.local` to Git!

---

## ☑️ PHASE 4: Update Docker Compose (2 min)

Edit `docker-compose.yml`, find `node_app` service:

```yaml
node_app:
  environment:
    - WHATSAPP_PHONE_NUMBER_ID=${WHATSAPP_PHONE_NUMBER_ID}
    - WHATSAPP_BUSINESS_ACCOUNT_ID=${WHATSAPP_BUSINESS_ACCOUNT_ID}
    - WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN}
    - WHATSAPP_VERIFY_TOKEN=${WHATSAPP_VERIFY_TOKEN}
```

---

## ☑️ PHASE 5: Install Dependencies (1 min)

```bash
cd dev-erp
npm install axios
```

---

## ☑️ PHASE 6: Add Code to `server.ts` (10 min)

Copy all code sections from `WHATSAPP_INTEGRATION_CODE.md`:

1. **Imports & Configuration** (at top of file)
2. **Helper functions** (sendWhatsAppMessage, formatPhoneNumber)
3. **Webhook endpoints** (GET and POST /webhook/whatsapp)
4. **API endpoint** (POST /api/send-whatsapp)
5. **Integration points** (add to existing order/waiter endpoints)

---

## ☑️ PHASE 7: Rebuild & Deploy (5 min)

```bash
# Rebuild Docker image
docker compose build --no-cache

# Restart containers
docker compose up -d

# Check logs
docker logs node_app
```

Expected: `✅ Server running on http://localhost:5001`

---

## ☑️ PHASE 8: Test It! (5 min)

### Test 1: Webhook Verification
```bash
curl -X GET "http://localhost:5001/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123"
```
Expected response: `test123`

### Test 2: Send Test Message
```bash
curl -X POST "http://localhost:5001/api/send-whatsapp" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210",
    "message": "Hello from Atithi-Setu!"
  }'
```
Expected: Message appears on your WhatsApp phone

### Test 3: End-to-End
1. Open app as Owner (localhost:5001)
2. Go to Command & Control tab
3. Create test order via QR code
4. Accept order as Chef
5. Check your phone for WhatsApp notification 📱

---

## 📊 What Gets Notified

| Event | Who Receives | Message |
|-------|---|---|
| Order Confirmed | Customer | ✅ Order confirmed |
| Order Preparing | Customer | 👨‍🍳 Being prepared, Est. 15m |
| Order Ready | Waiter + Customer | ✅ Ready to serve |
| Bill Requested | Manager | 💰 Table 3 requested bill |
| Waiter Called | Waiter | 📞 Customer calling |

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| Webhook verification fails | Check WHATSAPP_VERIFY_TOKEN matches in .env and Meta Dashboard |
| Messages not sending | Verify phone format: +91XXXXXXXXXX (with country code) |
| "Access token invalid" | Generate new token in Meta Dashboard → Settings |
| Phone not receiving messages | Ensure customer/manager phone has WhatsApp installed |
| "Message template not supported" | Use pre-approved templates for production |

---

## 💰 Costs

- **Setup:** FREE
- **Monthly cost:** ~$15-30 for 10,000 messages
  - First 1,000 customer conversations: FREE
  - Additional: $0.003-$0.007 per message (country dependent)

---

## 📚 Documentation Files

- **WHATSAPP_SETUP_GUIDE.md** → Full detailed setup (7 phases)
- **WHATSAPP_INTEGRATION_CODE.md** → Code snippets to copy
- **WHATSAPP_QUICK_START.md** → This file

---

## ✅ Completion Checklist

- [ ] All 4 credentials obtained from Meta Dashboard
- [ ] `.env.local` created with credentials
- [ ] Webhook URL configured in Meta Dashboard
- [ ] `docker-compose.yml` updated
- [ ] `axios` installed via npm
- [ ] Code added to `server.ts`
- [ ] Docker rebuild completed
- [ ] Webhook verification test passed
- [ ] Message sending test passed
- [ ] End-to-end order test successful
- [ ] Server logs show no errors

---

## 🎉 You're Done!

Your restaurant is now sending WhatsApp notifications!

**Next steps:**
- Monitor webhook events in Meta Dashboard
- Test with different customer scenarios
- Set up message templates for production
- Deploy to production domain

---

## 📞 Support Resources

- **Meta WhatsApp Docs:** https://developers.facebook.com/docs/whatsapp
- **Webhook Reference:** https://developers.facebook.com/docs/whatsapp/webhooks
- **Rate Limits:** 80 API calls/second per phone
- **Message Status:** sent → delivered → read

---

**Questions?** Check the full setup guide or Meta's official documentation.
