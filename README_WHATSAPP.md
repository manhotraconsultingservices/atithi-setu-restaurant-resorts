# 🚀 Enable WhatsApp Meta API Notifications - Complete Guide

## Overview

This document provides **step-by-step instructions** to enable WhatsApp notifications in Atithi-Setu.

**Total Setup Time:** 45-60 minutes
**Difficulty:** Intermediate
**Cost:** FREE to setup, ~$15-30/month for messages

---

## 📋 What You'll Get

✅ **Automatic WhatsApp notifications for:**
- Order Confirmations
- Order Preparation Updates
- Order Ready Alerts
- Bill Requests
- Waiter Call Notifications

✅ **Supports:**
- Multiple customer contacts
- Multi-language messages
- Rich media (emojis, formatting)
- Status tracking (sent, delivered, read)

---

## 🔑 4 Credentials You'll Need

Before starting, prepare these from Meta Dashboard:

```
1. WHATSAPP_PHONE_NUMBER_ID     = ___________________
2. WHATSAPP_BUSINESS_ACCOUNT_ID = ___________________
3. WHATSAPP_ACCESS_TOKEN        = ___________________
4. WHATSAPP_VERIFY_TOKEN        = ___________________
```

---

## 📖 COMPLETE STEP-BY-STEP INSTRUCTIONS

### SECTION A: Get API Credentials from Meta (15 minutes)

#### Step A.1: Create Meta Developer Account
1. Go to https://developers.facebook.com
2. Click **Sign Up** or **Log In**
3. Complete sign up with your email
4. Verify email

#### Step A.2: Create Business Account
1. Click **My Apps** → **Create App**
2. Choose **Business** as app type
3. Click **Create**
4. Fill in:
   - **App Name:** Atithi-Setu WhatsApp
   - **App Contact Email:** your@email.com
   - **App Purpose:** Business Messaging
5. Click **Create App**

#### Step A.3: Add WhatsApp Product
1. In app dashboard, scroll to **Add Products**
2. Find **WhatsApp Business Platform**
3. Click **Set Up**
4. Accept Terms & Conditions
5. **Wait 2-3 minutes** for setup to complete

#### Step A.4: Create/Link WhatsApp Business Account
1. Go to **WhatsApp** section (left menu)
2. Click **Create new account** OR link existing
3. Fill in:
   - **Display Name:** Atithi-Setu
   - **Phone Number:** +91XXXXXXXXXX (business number)
4. **Verify phone number** via SMS
5. Enter received code

#### Step A.5: Get API Credentials
1. In WhatsApp menu, go to **API Setup**
2. You'll see these credentials:
   ```
   Phone Number ID:           (looks like: 102045612345678)
   Business Account ID:        (looks like: 123456789)
   Access Token:              (long alphanumeric string)
   ```
3. **Copy all three and save them securely**

#### Step A.6: Create Verify Token
1. Go to **Configuration**
2. Generate a random secure token (example):
   ```
   my_secure_token_abc123xyz789
   ```
3. Save this as **WHATSAPP_VERIFY_TOKEN**

**✅ Section A Complete! You now have 4 credentials.**

---

### SECTION B: Configure Webhook in Meta (10 minutes)

#### Step B.1: Prepare Webhook URL

**For Production (AWS/Azure/etc):**
```
https://your-app-domain.com/webhook/whatsapp
```

**For Local Testing:**
1. Download ngrok: https://ngrok.com/download
2. Run: `ngrok http 5001`
3. Copy the forwarded URL: `https://xxx-xxx-xxx-xxx.ngrok.io`
4. Webhook URL: `https://xxx-xxx-xxx-xxx.ngrok.io/webhook/whatsapp`

#### Step B.2: Configure Webhook in Meta Dashboard
1. Go to **Configuration** in WhatsApp settings
2. Click **Edit** next to Webhook URL
3. Enter your webhook URL from Step B.1
4. Enter your **WHATSAPP_VERIFY_TOKEN** from Section A
5. Click **Verify and Save**
   - Meta will test the endpoint
   - If fails, check server logs for errors
   - If passes, you'll see ✅ Verified

#### Step B.3: Subscribe to Webhook Events
1. Still in **Configuration**
2. Under **Webhook Fields**, ensure these are checked:
   - ✅ **messages** (incoming messages)
   - ✅ **message_status** (delivery status)
   - ✅ **account_alerts**
3. Click **Save**

**✅ Section B Complete! Webhook is configured.**

---

### SECTION C: Set Environment Variables (5 minutes)

#### Step C.1: Create `.env.local` File
1. Open your project root: `C:\Users\Admin\Documents\Workspace_MCS\dev-erp.athiti-setu\dev-erp\`
2. Create new file named `.env.local`
3. Add these lines:

```env
# WhatsApp Meta API Configuration
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_from_step_a5
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_id_from_step_a5
WHATSAPP_ACCESS_TOKEN=your_access_token_from_step_a5
WHATSAPP_VERIFY_TOKEN=your_verify_token_from_step_a6
```

**Replace `your_xxx` with actual values from Section A!**

#### Step C.2: Verify `.env.local` Format
Make sure:
- No spaces around `=`
- No quotes around values
- Each value on new line
- File is named exactly `.env.local`

**✅ Section C Complete! Environment variables set.**

---

### SECTION D: Update Docker Configuration (3 minutes)

#### Step D.1: Edit `docker-compose.yml`
1. Open `docker-compose.yml` in your project root
2. Find the `node_app:` section
3. Add these environment variables:

```yaml
node_app:
  build: .
  container_name: node_app
  # ... existing config ...
  environment:
    # ... existing vars ...
    - WHATSAPP_PHONE_NUMBER_ID=${WHATSAPP_PHONE_NUMBER_ID}
    - WHATSAPP_BUSINESS_ACCOUNT_ID=${WHATSAPP_BUSINESS_ACCOUNT_ID}
    - WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN}
    - WHATSAPP_VERIFY_TOKEN=${WHATSAPP_VERIFY_TOKEN}
```

**✅ Section D Complete! Docker updated.**

---

### SECTION E: Install Required Package (2 minutes)

#### Step E.1: Install axios
1. Open terminal/cmd in project root
2. Run:
```bash
npm install axios
```

Expected output: `added X packages`

**✅ Section E Complete! Dependencies installed.**

---

### SECTION F: Add Code to `server.ts` (15 minutes)

#### Step F.1: Copy Helper Functions
1. Open `server.ts` in your project
2. Go to top of file (after imports)
3. Add all code from **WHATSAPP_INTEGRATION_CODE.md**, Section 1:
   - Imports (axios, dotenv)
   - Configuration (load env vars)
   - Helper functions (sendWhatsAppMessage, formatPhoneNumber)

#### Step F.2: Add Webhook Endpoints
1. Go to end of `server.ts` (before final exports)
2. Add all code from **WHATSAPP_INTEGRATION_CODE.md**, Section 2:
   - GET `/webhook/whatsapp` (verification)
   - POST `/webhook/whatsapp` (receive messages)

#### Step F.3: Add Send Endpoint
1. Still in `server.ts`, after webhook endpoints
2. Add code from **WHATSAPP_INTEGRATION_CODE.md**, Section 3:
   - POST `/api/send-whatsapp` (send messages)

#### Step F.4: Integrate with Existing Workflows
1. Find the PATCH `/api/orders/:id` endpoint
2. Add WhatsApp notification code from **WHATSAPP_INTEGRATION_CODE.md**, Section 4
3. Find or create `POST /api/call-waiter` endpoint
4. Add WhatsApp code from Section 5

**✅ Section F Complete! Code integrated.**

---

### SECTION G: Build & Deploy (5 minutes)

#### Step G.1: Rebuild Docker
1. Open terminal in project root
2. Run:
```bash
docker compose build --no-cache
```
Expected: `✅ Image dev-erp-app Built`

#### Step G.2: Restart Containers
1. Run:
```bash
docker compose up -d
```
Expected: All containers start successfully

#### Step G.3: Verify Server Started
1. Run:
```bash
docker logs node_app
```
Look for: `✅ Server running on http://localhost:5001`

**✅ Section G Complete! Server is running.**

---

### SECTION H: Test WhatsApp Integration (10 minutes)

#### Test H.1: Webhook Verification
1. Open your terminal
2. Run:
```bash
curl -X GET "http://localhost:5001/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123"
```

**Replace `YOUR_VERIFY_TOKEN` with value from Step A.6**

Expected response: `test123`

If fails: Check WHATSAPP_VERIFY_TOKEN in `.env.local`

#### Test H.2: Send Test Message
1. Get your JWT token by logging in as restaurant owner
2. Run:
```bash
curl -X POST "http://localhost:5001/api/send-whatsapp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "phone": "+919876543210",
    "message": "Hello from Atithi-Setu! 🎉"
  }'
```

**Replace:**
- `YOUR_JWT_TOKEN` with actual token from Step 2
- `+919876543210` with your phone number

Expected response:
```json
{"success": true, "phone": "+919876543210"}
```

**Check your phone** - you should receive the WhatsApp message!

#### Test H.3: End-to-End Order Flow
1. Open app: http://localhost:5001
2. Log in as restaurant owner
3. Switch to CUSTOMER mode: http://localhost:5001/?r=1001&table=1
4. Place an order via QR
5. Log in as CHEF (different browser/device)
6. Accept the order
7. Set ETA to 15 minutes
8. Mark as READY
9. **Check your phone** for notifications 📱

Expected WhatsApp messages:
- "✅ Order confirmed!"
- "👨‍🍳 Being prepared, Est. 15 minutes"
- "✅ Ready to serve!"

**✅ Section H Complete! Integration tested successfully!**

---

## ✅ Final Checklist

Before considering setup complete, verify:

- [ ] Meta Developer Account created
- [ ] WhatsApp Business Account set up
- [ ] Phone number verified
- [ ] 4 API credentials copied
- [ ] Webhook URL verified in Meta Dashboard
- [ ] `.env.local` file created with credentials
- [ ] `docker-compose.yml` updated
- [ ] `axios` package installed
- [ ] Code added to `server.ts` (all 6 sections)
- [ ] Docker rebuilt successfully
- [ ] Server started without errors
- [ ] Webhook verification test passed
- [ ] Test message sent successfully
- [ ] End-to-end order test successful
- [ ] Messages appear on phone 📱

---

## 🚨 Troubleshooting

### Problem: Webhook verification fails
**Solution:**
- Check WHATSAPP_VERIFY_TOKEN matches exactly
- Verify URL is publicly accessible (not localhost for production)
- Check for typos in `.env.local`

### Problem: Test message not sending
**Solution:**
- Verify phone format: +91XXXXXXXXXX (with country code)
- Check ACCESS_TOKEN is correct and not expired
- Check server logs: `docker logs node_app`

### Problem: "Access token invalid"
**Solution:**
- Go to Meta Dashboard → Apps → Settings
- Click "Generate Token" for new token
- Update WHATSAPP_ACCESS_TOKEN in `.env.local`
- Restart containers

### Problem: Phone number not receiving messages
**Solution:**
- Ensure phone has WhatsApp installed
- Verify phone number is in E.164 format (+country_code_number)
- Check if number is blocked or opted-out
- Try a different phone number

---

## 📊 What Gets Notified

| Scenario | Message | Who Gets It |
|----------|---------|------------|
| Order Placed | ✅ Order confirmed! | Customer |
| Chef Accepts | 👨‍🍳 Being prepared, Est. 15min | Customer |
| Order Ready | ✅ Ready to serve! | Customer + Waiter |
| Bill Requested | 💰 Bill request from Table 5 | Manager |
| Waiter Called | 📞 Customer calling from Table 3 | Assigned Waiter |

---

## 💰 Cost Breakdown

| Item | Cost |
|------|------|
| WhatsApp Business Account | FREE |
| Setup (first 1,000 messages) | FREE |
| Each message after 1,000 | $0.003 - $0.007 |
| Monthly estimate (10K msgs) | $15-30 |

---

## 🔒 Security Best Practices

1. **Never commit `.env.local` to Git**
   - Add to `.gitignore`:
   ```
   .env.local
   .env
   ```

2. **Use HTTPS for webhook** (production only)
   - Required by Meta for security

3. **Rotate access tokens regularly**
   - Generate new tokens monthly

4. **Monitor message delivery**
   - Check success rates in Meta Dashboard

5. **Rate limit API calls**
   - Max 80 calls/second per phone

---

## 📚 Documentation Files

You now have these reference files:

- **README_WHATSAPP.md** ← You are here (Quick start)
- **WHATSAPP_SETUP_GUIDE.md** (Detailed setup with explanations)
- **WHATSAPP_INTEGRATION_CODE.md** (Code snippets to copy)
- **WHATSAPP_QUICK_START.md** (Checklist format)
- **WHATSAPP_FLOW_DIAGRAM.md** (Visual architecture)

---

## ✨ Next Steps After Setup

1. **Monitor Message Delivery**
   - Check Meta Dashboard for success rates
   - Set up alerts for failures

2. **Customize Messages**
   - Add restaurant name/logo
   - Use message templates for compliance

3. **Scale for Production**
   - Update to production domain
   - Configure SSL/HTTPS
   - Set up message queuing for high volume

4. **Optimize Performance**
   - Monitor API response times
   - Add retry logic for failed messages
   - Implement message batching

5. **Add Analytics**
   - Track message delivery rates
   - Analyze customer engagement
   - ROI measurement

---

## 🎯 Success Criteria

Your WhatsApp integration is successful when:

✅ Test messages arrive on your phone
✅ Order notifications sent automatically
✅ Waiter receives call notifications
✅ Manager gets bill alerts
✅ No errors in server logs
✅ <2 second message delivery time
✅ >95% message success rate

---

## 📞 Getting Help

If you get stuck:

1. **Check troubleshooting section** above
2. **Review error messages** in `docker logs node_app`
3. **Verify credentials** from Meta Dashboard
4. **Test webhook** with curl commands
5. **Read Meta docs:** https://developers.facebook.com/docs/whatsapp

---

## 🎉 Congratulations!

You've successfully integrated WhatsApp notifications into Atithi-Setu!

Your restaurant can now:
- 📱 Send automatic order updates
- ⏰ Notify customers of ETAs
- 🔔 Alert staff of waiter calls
- 💰 Notify managers of billing requests
- 📊 Track all message delivery

**Total Setup Time:** ~45 minutes
**Impact:** ⭐⭐⭐⭐⭐ Massive customer satisfaction boost!

---

**Questions?** Refer to the other WhatsApp documentation files or Meta's official API documentation.

**Ready to go live?** Make sure all checks in the Final Checklist are complete!
