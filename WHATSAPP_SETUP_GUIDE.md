# WhatsApp Meta API Setup Guide for Atithi-Setu

## Overview
This guide will help you integrate WhatsApp notifications into Atithi-Setu using Meta's WhatsApp Business API.

---

## Phase 1: Meta Business Account Setup (15-20 minutes)

### Step 1.1: Create/Access Meta Business Account
1. Go to [https://www.facebook.com/business/tools/meta-business-suite](https://www.facebook.com/business/tools/meta-business-suite)
2. Sign in with your Facebook account (create one if needed)
3. Click "Create Account" if you don't have a Business Account
4. Fill in:
   - Business Name: "Atithi-Setu"
   - Your Name
   - Business Email
   - Business Phone Number
   - Country & Time Zone

### Step 1.2: Verify Your Phone Number
- After account creation, verify your phone number
- You'll receive an SMS or call with a verification code

### Step 1.3: Access Meta Developer Dashboard
1. Go to [https://developers.facebook.com](https://developers.facebook.com)
2. Click "My Apps" → "Create App"
3. Choose **Business** as app type
4. Fill in App Details:
   - App Name: "Atithi-Setu WhatsApp"
   - App Contact Email: your-email@domain.com
   - App Purpose: Business Messaging

---

## Phase 2: WhatsApp Business API Setup (20-30 minutes)

### Step 2.1: Get WhatsApp Business Account
1. In Meta App Dashboard, go to **Add Product**
2. Search for **WhatsApp**
3. Click **Set Up** on WhatsApp Business Platform
4. Accept Terms & Conditions

### Step 2.2: Create/Link Phone Number
1. Go to **App Roles** → **Accounts** → **WhatsApp Accounts**
2. Click **Create New Account** OR link existing WhatsApp Business account
3. Fill in:
   - Display Name: "Atithi-Setu"
   - Phone Number: +91 XXXXXXXXXX (your restaurant's business number)
   - Verify the phone number via SMS

### Step 2.3: Get API Credentials
1. In WhatsApp settings, go to **API Setup**
2. You'll see:
   - **Phone Number ID** (e.g., 102045612345678)
   - **Business Account ID** (e.g., 123456789)
   - **Access Token** (long string)

**⚠️ IMPORTANT:** Save these securely! You'll need them in the code.

### Step 2.4: Configure Webhook
1. Go to **Configuration** section
2. Click **Edit** on Webhook URL:
   - Set Webhook URL: `https://your-app-domain.com/webhook/whatsapp`
   - Set Verify Token: Create a random secure string (e.g., `your_secure_verify_token_12345`)
3. Click **Verify and Save**

### Step 2.5: Subscribe to Webhook Events
1. Under **Webhook Fields**, select:
   - ✅ **messages** (receive incoming messages)
   - ✅ **message_status** (delivery/read status)
   - ✅ **account_alerts**

---

## Phase 3: Set Up Environment Variables (5 minutes)

### Step 3.1: Create `.env.local` file
In your project root, create or update `.env.local`:

```env
# WhatsApp Meta API Configuration
WHATSAPP_PHONE_NUMBER_ID=102045612345678
WHATSAPP_BUSINESS_ACCOUNT_ID=123456789
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_VERIFY_TOKEN=your_secure_verify_token_12345
```

**Replace with YOUR actual credentials from Step 2.3**

### Step 3.2: Update Docker Environment
Update `docker-compose.yml` to pass env vars to the Node app:

```yaml
node_app:
  environment:
    - WHATSAPP_PHONE_NUMBER_ID=${WHATSAPP_PHONE_NUMBER_ID}
    - WHATSAPP_BUSINESS_ACCOUNT_ID=${WHATSAPP_BUSINESS_ACCOUNT_ID}
    - WHATSAPP_ACCESS_TOKEN=${WHATSAPP_ACCESS_TOKEN}
    - WHATSAPP_VERIFY_TOKEN=${WHATSAPP_VERIFY_TOKEN}
```

---

## Phase 4: Code Integration (Implementation in `server.ts`)

### Step 4.1: Install Dependencies
```bash
npm install axios dotenv
```

### Step 4.2: Update `server.ts`
(See `WHATSAPP_INTEGRATION_CODE.ts` for implementation details)

Key additions:
- Load WhatsApp environment variables
- Add `/webhook/whatsapp` POST endpoint for sending messages
- Add `/webhook/whatsapp` GET endpoint for webhook verification
- Create helper functions for WhatsApp API calls
- Integrate notifications in existing order workflow

### Step 4.3: Integration Points

**When to send WhatsApp notifications:**

1. **Order Confirmation** → Send to customer's phone
   ```
   "Your order #ORD-123456 is confirmed! 🎉"
   ```

2. **Order Preparing** → Send to customer
   ```
   "👨‍🍳 Your order is being prepared. Est. ready in 15 minutes"
   ```

3. **Order Ready** → Send to waiter & customer
   ```
   "✅ Order #ORD-123456 is ready to serve!"
   ```

4. **Waiter Call Request** → Send to assigned waiter
   ```
   "📞 Customer at Table 5 is calling you"
   ```

5. **Bill Request** → Send to waiter/manager
   ```
   "💰 Customer at Table 3 requested bill"
   ```

---

## Phase 5: Testing (10 minutes)

### Step 5.1: Test Webhook Verification
```bash
curl -X GET "http://localhost:5001/webhook/whatsapp?hub.mode=subscribe&hub.challenge=test_challenge&hub.verify_token=your_verify_token"
```

Expected response: `test_challenge`

### Step 5.2: Test Sending Message
Use this test request:

```bash
curl -X POST "http://localhost:5001/api/send-whatsapp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "phone": "+91XXXXXXXXXX",
    "message": "Test message from Atithi-Setu!",
    "type": "order_ready"
  }'
```

### Step 5.3: Full Integration Test
1. Log in as Restaurant Owner
2. Create a test order
3. Mark order as PREPARING
4. Set ETA (15 minutes)
5. Check if WhatsApp message is sent to customer's phone
6. Mark as READY
7. Verify waiter receives notification

---

## Phase 6: Production Deployment (Optional but Recommended)

### Step 6.1: Get Production Approval
1. Submit WhatsApp app for review (if using sandbox mode)
2. Meta team will verify your business
3. Approval typically takes 24-48 hours

### Step 6.2: Update Webhook URL to Production
1. Change webhook URL from `localhost` to your production domain
2. Update DNS/firewall to allow WhatsApp Meta servers

### Step 6.3: Update Environment Variables
```env
WHATSAPP_PHONE_NUMBER_ID=your_prod_phone_id
WHATSAPP_ACCESS_TOKEN=your_prod_token
# etc.
```

---

## Phase 7: Troubleshooting

### Issue: "Webhook verification failed"
**Solution:** Check that WHATSAPP_VERIFY_TOKEN matches exactly in code and Meta dashboard

### Issue: "Access token invalid or expired"
**Solution:** Generate new access token in Meta dashboard → Settings → User Tokens

### Issue: "Phone number not verified"
**Solution:** Complete phone number verification in WhatsApp settings

### Issue: "Message not being sent"
**Solution:**
- Check if customer phone number is in international format (+91...)
- Verify access token is still valid
- Check server logs for API errors

---

## API Reference: WhatsApp Endpoints

### Send Message
```
POST /api/send-whatsapp
Authorization: Bearer {jwt_token}
Content-Type: application/json

{
  "phone": "+91XXXXXXXXXX",
  "message": "Your order is ready!",
  "type": "order_ready" | "order_preparing" | "waiter_call" | "bill_request"
}

Response: { "success": true, "messageId": "wamid.xxx" }
```

### Webhook Verification (GET)
```
GET /webhook/whatsapp?hub.mode=subscribe&hub.verify_token={token}&hub.challenge={challenge}

Response: {challenge}
```

### Webhook Events (POST)
```
POST /webhook/whatsapp
Content-Type: application/json

{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "+91XXXXXXXXXX",
          "type": "text",
          "text": { "body": "Message from customer" }
        }]
      }
    }]
  }]
}
```

---

## Security Checklist

- ✅ Store tokens in `.env.local` (never commit to Git)
- ✅ Use HTTPS for webhook URL (not HTTP)
- ✅ Validate webhook signature from Meta
- ✅ Rate limit API calls (avoid spamming)
- ✅ Encrypt sensitive data in database
- ✅ Log all WhatsApp transactions
- ✅ Implement message retry logic

---

## Support & Documentation

- **Meta WhatsApp API Docs:** https://developers.facebook.com/docs/whatsapp/cloud-api/
- **Webhook Reference:** https://developers.facebook.com/docs/whatsapp/webhooks/
- **Rate Limits:** 80 API calls per second per phone number
- **Message Templates:** Use pre-approved message templates for production

---

## Cost Estimate

- **WhatsApp Business Account:** FREE
- **API Calls:** Charged per message sent
  - First 1,000 customer conversations/month: FREE
  - Additional conversations: $0.003 - $0.007 per message (varies by country)

**Estimated cost for 10,000 messages/month: $15-30**

---

## Next Steps

1. ✅ Complete Phase 1-3 (Account & API setup)
2. ✅ Implement code changes (Phase 4)
3. ✅ Run tests (Phase 5)
4. ✅ Deploy to production (Phase 6)
5. ✅ Monitor and optimize (ongoing)

Questions? Check Meta's official docs or contact support.
