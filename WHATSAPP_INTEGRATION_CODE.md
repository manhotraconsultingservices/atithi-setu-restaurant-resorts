# WhatsApp Integration Code Implementation

This file shows exactly what code to add to `server.ts` to enable WhatsApp notifications.

---

## Step 1: Add to `server.ts` - Imports & Configuration

```typescript
// Add these imports at the top of server.ts
import axios from 'axios';

// WhatsApp Configuration
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = 'v18.0';
const WHATSAPP_API_URL = `https://graph.instagram.com/${WHATSAPP_API_VERSION}`;

// Helper function to send WhatsApp message
async function sendWhatsAppMessage(
  recipientPhone: string,
  messageBody: string,
  messageType: string = 'text'
): Promise<boolean> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log('⚠️  WhatsApp not configured. Skipping message.');
    return false;
  }

  try {
    const payload = {
      messaging_product: 'whatsapp',
      to: recipientPhone.replace(/[^0-9+]/g, ''), // Ensure E.164 format
      type: 'text',
      text: {
        body: messageBody
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ WhatsApp message sent to ${recipientPhone}`);
    console.log(`   Message ID: ${response.data.messages[0].id}`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to send WhatsApp message to ${recipientPhone}`);
    console.error(`   Error: ${error.response?.data?.error?.message || error.message}`);
    return false;
  }
}

// Helper function to format phone number (add +91 if needed)
function formatPhoneNumber(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `+91${cleaned}`;
  } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
    return `+${cleaned}`;
  }
  return phone.startsWith('+') ? phone : `+${phone}`;
}
```

---

## Step 2: Add Webhook Endpoints

```typescript
// WEBHOOK VERIFICATION ENDPOINT (GET)
// This is called by Meta when you set up the webhook URL
app.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    console.error('❌ WhatsApp webhook verification failed');
    res.status(403).json({ error: 'Invalid verify token' });
  }
});

// WEBHOOK RECEIVE ENDPOINT (POST)
// This receives incoming messages and status updates from WhatsApp
app.post('/webhook/whatsapp', (req: Request, res: Response) => {
  try {
    const body = req.body;

    // Verify the webhook signature (recommended for production)
    if (body.object === 'whatsapp_business_account') {
      body.entry?.forEach((entry: any) => {
        entry.changes?.forEach((change: any) => {
          const value = change.value;

          // Handle incoming messages
          if (value.messages) {
            value.messages.forEach((message: any) => {
              const from = message.from;
              const messageBody = message.text?.body;
              const messageType = message.type;

              console.log(`📨 Incoming WhatsApp message:`);
              console.log(`   From: ${from}`);
              console.log(`   Type: ${messageType}`);
              console.log(`   Body: ${messageBody}`);

              // TODO: Process incoming message
              // Example: Update customer interaction, log feedback, etc.
            });
          }

          // Handle message status updates (sent, delivered, read)
          if (value.statuses) {
            value.statuses.forEach((status: any) => {
              console.log(`📊 WhatsApp message status:`);
              console.log(`   Message ID: ${status.id}`);
              console.log(`   Status: ${status.status}`);
              console.log(`   Timestamp: ${status.timestamp}`);
            });
          }
        });
      });

      // Always respond with 200 OK to acknowledge receipt
      res.status(200).json({ success: true });
    } else {
      res.status(400).json({ error: 'Invalid object type' });
    }
  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## Step 3: Add API Endpoint to Send WhatsApp Messages

```typescript
// SEND WHATSAPP MESSAGE ENDPOINT
// Protected endpoint - requires authentication
app.post('/api/send-whatsapp', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { phone, message, type } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const success = await sendWhatsAppMessage(formattedPhone, message, type);

    if (success) {
      res.json({ success: true, phone: formattedPhone });
    } else {
      res.status(500).json({ error: 'Failed to send WhatsApp message' });
    }
  } catch (err) {
    console.error('Error in /api/send-whatsapp:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## Step 4: Integrate with Order Lifecycle

Add WhatsApp notifications when orders status changes:

```typescript
// Modify the existing PATCH /api/orders/:id endpoint
// Add this BEFORE the res.json() call at the end

// Send WhatsApp notifications based on status
const notification = {
  PREPARING: {
    template: 'Order is being prepared',
    emoji: '👨‍🍳'
  },
  READY: {
    template: 'Your order is ready! Staff will serve shortly.',
    emoji: '✅'
  },
  DELIVERED: {
    template: 'Order delivered. Thank you for dining with us!',
    emoji: '✔'
  }
};

if (status && notification[status as keyof typeof notification]) {
  const note = notification[status as keyof typeof notification];
  const eta_text = eta ? ` Est. ${eta} remaining` : '';
  const message = `${note.emoji} ${note.template}${eta_text}\n\nOrder: ${req.params.id}`;

  // Get customer phone from session
  try {
    const session = await db.get(
      "SELECT customer_phone FROM table_sessions WHERE order_id = ?",
      [req.params.id]
    );

    if (session?.customer_phone) {
      const formattedPhone = formatPhoneNumber(session.customer_phone);

      // Send async (don't wait for response)
      sendWhatsAppMessage(formattedPhone, message, 'order_status').catch(err => {
        console.error('Failed to send WhatsApp:', err);
      });
    }
  } catch (err) {
    console.error('Error fetching session for WhatsApp:', err);
  }
}
```

---

## Step 5: Integrate with Waiter Call Feature

```typescript
// Add to existing POST /api/call-waiter endpoint

// Send WhatsApp to assigned waiter
if (waiter?.phone) {
  const message = `📞 Customer at ${tableName} is calling you.\n\nSession: ${session?.session_token}`;
  const formattedPhone = formatPhoneNumber(waiter.phone);

  sendWhatsAppMessage(formattedPhone, message, 'waiter_call').catch(err => {
    console.error('Failed to send waiter call notification:', err);
  });
}
```

---

## Step 6: Integrate with Bill Request

```typescript
// Add to existing bill request handling

// Notify waiter/manager of bill request
if (manager?.phone) {
  const message = `💰 Bill request from Table ${table?.table_number}.\n\nCustomer name: ${session?.customer_name}\n\nSession: ${session?.session_token}`;
  const formattedPhone = formatPhoneNumber(manager.phone);

  sendWhatsAppMessage(formattedPhone, message, 'bill_request').catch(err => {
    console.error('Failed to send bill notification:', err);
  });
}
```

---

## Step 7: Update `index.html` - Add Package Installation

Make sure `package.json` includes axios:

```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.0.0"
  }
}
```

Install with:
```bash
npm install axios dotenv
```

---

## Environment Variables Checklist

Create `.env.local` with:

```env
# WhatsApp Configuration
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id_here
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_VERIFY_TOKEN=your_unique_verify_token_here
```

**DO NOT commit `.env.local` to Git!**

---

## Testing the Integration

### Test 1: Verify Webhook Setup
```bash
curl -X GET "http://localhost:5001/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=your_verify_token&hub.challenge=test123"
```

Expected: Returns `test123`

### Test 2: Send Test Message
```bash
curl -X POST "http://localhost:5001/api/send-whatsapp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "phone": "+919876543210",
    "message": "Hello from Atithi-Setu! 🎉",
    "type": "test"
  }'
```

### Test 3: End-to-End Order Flow
1. Create order via customer QR scan
2. Accept order in Chef dashboard
3. Check if customer receives WhatsApp: "👨‍🍳 Order is being prepared"
4. Mark as READY
5. Check if customer receives: "✅ Your order is ready!"

---

## Message Templates (Best Practices)

For production, use Meta's pre-approved message templates:

```
Order Confirmation:
"Your order #{{order_id}} is confirmed! 🎉
Items: {{items}}
Total: ₹{{amount}}
Status: Preparing"

Order Preparing:
"👨‍🍳 Your order is being prepared.
Estimated time: {{eta}}
Sit back and relax!"

Order Ready:
"✅ Your order #{{order_id}} is ready!
Staff will serve it to your table shortly.
Thank you for dining with us! 🙏"
```

---

## Troubleshooting

**Error: "Access token is invalid or expired"**
- Go to Meta Dashboard → Apps → WhatsApp → Settings
- Click "Generate Token" again
- Update WHATSAPP_ACCESS_TOKEN in `.env.local`

**Error: "Phone number not in correct format"**
- Phone must be in E.164 format: +[country_code][number]
- Example: +919876543210 (not 9876543210)

**Error: "Webhook verification failed"**
- Double-check WHATSAPP_VERIFY_TOKEN in `.env.local` and Meta Dashboard match exactly
- Ensure webhook URL is publicly accessible (not localhost for production)

**Messages not being sent**
- Check if WHATSAPP_PHONE_NUMBER_ID is correct
- Verify phone number is verified in WhatsApp Business Account
- Check server logs for API errors
- Ensure customer phone has WhatsApp installed

---

## Security Notes

1. **Never** commit tokens to Git
2. **Use HTTPS** for production webhook URLs
3. **Validate** webhook signatures from Meta
4. **Rate limit** API calls (80 calls/second max)
5. **Log** all transactions for audit
6. **Encrypt** phone numbers in database
7. **Use approved templates** in production for compliance

---

## Performance Optimization

```typescript
// Add message queuing for high volume
const messageQueue: any[] = [];
let isProcessing = false;

async function processMessageQueue() {
  if (isProcessing || messageQueue.length === 0) return;

  isProcessing = true;
  const message = messageQueue.shift();

  await sendWhatsAppMessage(message.phone, message.text, message.type);

  // Small delay to respect rate limits
  setTimeout(() => {
    isProcessing = false;
    processMessageQueue();
  }, 100);
}

// Use queue instead of direct send
function queueWhatsAppMessage(phone: string, text: string, type: string) {
  messageQueue.push({ phone, text, type });
  processMessageQueue();
}
```

---

## Next Steps

1. Complete setup in WHATSAPP_SETUP_GUIDE.md (Phases 1-3)
2. Copy code from this file into `server.ts`
3. Install dependencies: `npm install axios`
4. Set environment variables in `.env.local`
5. Rebuild Docker container: `docker compose build --no-cache`
6. Run tests from Phase 5
7. Deploy to production

Good luck! 🚀
