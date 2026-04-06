# WhatsApp Integration Flow Diagrams

## Overall Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ATITHI-SETU APPLICATION                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ (HTTPS)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   BACKEND (Node.js/Express)                     │
│                       server.ts                                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  REST Endpoints                                         │   │
│  │  • POST /api/send-whatsapp                              │   │
│  │  • GET  /webhook/whatsapp (verification)                │   │
│  │  • POST /webhook/whatsapp (incoming messages)           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  WhatsApp Helper Functions                              │   │
│  │  • sendWhatsAppMessage()                                │   │
│  │  • formatPhoneNumber()                                  │   │
│  │  • queueWhatsAppMessage() [optional]                    │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ (HTTPS API)
                              ▼
            ┌────────────────────────────────────┐
            │  META WHATSAPP CLOUD API           │
            │                                    │
            │  Version: v18.0                    │
            │  URL: graph.instagram.com/v18.0    │
            │                                    │
            │  Authentication: Bearer Token      │
            └────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
        ┌──────────────────┐  ┌──────────────────┐
        │  SEND MESSAGES   │  │ RECEIVE WEBHOOKS │
        │  to WhatsApp     │  │ from WhatsApp    │
        │                  │  │                  │
        │ Outbound Flow    │  │ Inbound Flow     │
        └──────────────────┘  └──────────────────┘
                    │                   │
                    ▼                   ▼
        ┌──────────────────┐  ┌──────────────────┐
        │   CUSTOMER PHONE │  │  INCOMING MSGS   │
        │                  │  │  MESSAGE STATUS  │
        │  📱 Receives:    │  │  ACCOUNT ALERTS  │
        │  • Order status  │  │                  │
        │  • ETA updates   │  │  Return to App:  │
        │  • Bill request  │  │  • Feedback      │
        │  • Waiter call   │  │  • Custom msgs   │
        └──────────────────┘  └──────────────────┘
```

---

## Message Flow: Order Lifecycle

```
CUSTOMER SCANS QR
       │
       ▼
┌──────────────────┐
│ CREATE ORDER     │
│ (Status: PENDING)│
└──────────────────┘
       │
       ▼
    CONFIRMED
       │
       ├─────────────────────────────────────┐
       │                                     │
       ▼                                     │
   CHEF ACCEPTS                             │
   (kitchen_status: accepted)                │
       │                                     │
       ├──► [SEND WHATSAPP]                  │
       │    "✅ Order confirmed!"            │
       │    "Items: Paneer Tikka, Chili..."  │
       │    To: Customer Phone               │
       │                                     │
       ▼                                     │
  STARTS PREPARING                           │
  (Status: PREPARING)                        │
       │                                     │
       ├──► [SEND WHATSAPP]                  │
       │    "👨‍🍳 Being prepared"              │
       │    "ETA: 15 minutes"                │
       │    To: Customer Phone               │
       │                                     │
       ▼                                     │
   MARKS READY                               │
   (Status: READY)                           │
       │                                     │
       ├──► [SEND WHATSAPP]                  │
       │    "✅ Ready to serve!"             │
       │    "Staff bringing it to table..."  │
       │    To: Customer + Waiter + Manager  │
       │                                     │
       ▼                                     │
  CUSTOMER REQUESTS BILL                     │
       │                                     │
       ├──► [SEND WHATSAPP]                  │
       │    "💰 Bill requested"              │
       │    "Table: 5"                       │
       │    To: Manager/Owner                │
       │                                     │
       ▼                                     │
  PAYMENT COLLECTED                          │
       │                                     │
       ├──► [SEND WHATSAPP]                  │
       │    "✅ Thank you! Visit again"      │
       │    To: Customer Phone               │
       │                                     │
       ▼                                     │
   SESSION CLOSED◄───────────────────────────┘
   (Status: DELIVERED)
```

---

## Message Flow: Waiter Call

```
CUSTOMER AT TABLE
       │
       ▼
CLICKS "CALL WAITER"
       │
       ├──► App: waiterCallStatus = 'sending'
       │
       ▼
API: POST /api/call-waiter
       │
       ├──► Database: Insert waiter_call record
       │
       ├──► Find: Assigned waiter for table
       │
       ├──► Format: Waiter's phone number
       │
       ├──► Call: sendWhatsAppMessage()
       │
       ├──► Meta API: Send message
       │
       ├──► Response: messageId
       │
       ├──► WebSocket: Broadcast WAITER_CALL_UPDATE
       │
       ▼
CUSTOMER SEES: "📞 Calling waiter..."
WAITER GETS:   "📞 Customer at Table 5 calling"
       │
       ├──► Waiter: waiterCallStatus = 'sent'
       │    (in customer's browser)
       │
       ├──► App: Sets 90s cooldown timer
       │
       ▼
WAITER RESPONDS (via app or WhatsApp)
       │
       ├──► App: waiterCallStatus = 'acknowledged'
       │
       ├──► Send: "👋 Waiter is on the way!"
       │
       ▼
CUSTOMER RECEIVES: "Waiter is on the way! 👋"
       │
       ▼
[OPTIONAL] Waiter marks as "Resolved"
       │
       ├──► WebSocket: waiterCallStatus = 'idle'
       │
       ▼
BUTTON RE-ENABLED: Customer can call again
```

---

## Webhook Event Flow

```
┌─────────────────────────────────────┐
│  Meta WhatsApp Sends Webhook Event  │
│  (Via HTTPS POST)                   │
└─────────────────────────────────────┘
                  │
                  ▼
    POST /webhook/whatsapp
                  │
                  ├─► Verify webhook is from Meta
                  │   (Check signature/token)
                  │
                  ▼
         Parse webhook body
                  │
        ┌─────────┴──────────┐
        │                    │
        ▼                    ▼
    INCOMING MESSAGE     MESSAGE STATUS
    (type: text/image)   (sent/delivered/read)
        │                    │
        ├─► Extract:         ├─► Log: Message ID
        │   • From: +91xxx   │   • Status
        │   • Text body      │   • Timestamp
        │   • Message ID     │
        │                    │
        ├─► Store in DB      ├─► Update DB
        │   (customer_msgs)  │   (message_status)
        │                    │
        ├─► Process msg      ├─► Notify Manager
        │   • Feedback?      │   (Dashboard update)
        │   • Sentiment?     │
        │   • Action needed? │
        │                    │
        ▼                    ▼
    Return 200 OK        Return 200 OK
    (acknowledge)        (acknowledge)
```

---

## Data Flow: Sending Message

```
INPUT:
  phone: "+919876543210"
  message: "Your order is ready!"
  type: "order_ready"
       │
       ▼
FORMAT PHONE NUMBER
  +919876543210 (ensure E.164 format)
       │
       ▼
BUILD PAYLOAD
  {
    "messaging_product": "whatsapp",
    "to": "+919876543210",
    "type": "text",
    "text": {
      "body": "Your order is ready!"
    }
  }
       │
       ▼
AUTHENTICATE
  Header: Authorization: Bearer {ACCESS_TOKEN}
       │
       ▼
SEND TO META API
  POST /v18.0/{PHONE_NUMBER_ID}/messages
       │
       ├─► Success (200)
       │   └─► Response:
       │       {
       │         "messages": [{
       │           "id": "wamid.xxx",
       │           "message_status": "accepted"
       │         }]
       │       }
       │
       ├─► Log success
       │
       ├─► Return: { success: true }
       │
       └─► WebSocket: Message sent notification
       │
       └─► Error (400/401/429/500)
           ├─► Log error details
           ├─► Retry logic (optional)
           ├─► Return: { success: false }
           └─► Alert admin if critical
```

---

## Environment & Configuration Flow

```
┌────────────────────────────────────┐
│      Meta Business Dashboard       │
│                                    │
│  • Phone Number ID                 │
│  • Business Account ID             │
│  • Access Token                    │
│  • Verify Token                    │
│  • Webhook URL                     │
└────────────────────────────────────┘
             │
             │ (Manual copy)
             ▼
┌────────────────────────────────────┐
│      Developer creates             │
│       .env.local                   │
│                                    │
│  WHATSAPP_PHONE_NUMBER_ID=xxx      │
│  WHATSAPP_BUSINESS_ACCOUNT_ID=xxx  │
│  WHATSAPP_ACCESS_TOKEN=xxx         │
│  WHATSAPP_VERIFY_TOKEN=xxx         │
└────────────────────────────────────┘
             │
             │ (Git ignored)
             ▼
┌────────────────────────────────────┐
│    Loaded into Node process        │
│    via process.env                 │
└────────────────────────────────────┘
             │
             │
       ┌─────┴─────┐
       │            │
       ▼            ▼
   Used in API   Used in requests
   endpoints     to Meta servers
```

---

## Security & Rate Limiting Flow

```
INCOMING REQUEST: POST /api/send-whatsapp
       │
       ├─► [1] Authenticate
       │   └─► Verify JWT token
       │       ├─► Valid? Continue
       │       └─► Invalid? Return 401
       │
       ├─► [2] Validate Input
       │   ├─► Phone exists?
       │   ├─► Message exists?
       │   ├─► Phone format valid?
       │   └─► All OK? Continue
       │
       ├─► [3] Rate Limiting
       │   ├─► Track: requests per user
       │   ├─► Limit: 10 msgs/min
       │   ├─► Over limit? Return 429
       │   └─► Under limit? Continue
       │
       ├─► [4] Format Phone
       │   ├─► Add country code if needed
       │   └─► Verify E.164 format
       │
       ├─► [5] Call WhatsApp API
       │   ├─► Include: Bearer token
       │   ├─► Timeout: 10 seconds
       │   └─► Retry: 2 times on failure
       │
       ├─► [6] Log Transaction
       │   ├─► User ID
       │   ├─► Phone
       │   ├─► Message (first 100 chars)
       │   ├─► Timestamp
       │   └─► Success/Failure
       │
       ├─► [7] Return Response
       │   ├─► Success: { success: true }
       │   └─► Error: { error: "..." }
       │
       ▼
    END
```

---

## Integration Checklist with Flow

```
✅ Phase 1: Meta Setup
   ├─ Create app
   ├─ Generate credentials
   └─ Verify phone number

✅ Phase 2: Webhook Configuration
   ├─ Set webhook URL
   ├─ Set verify token
   └─ Subscribe to events

✅ Phase 3: Environment Variables
   ├─ Create .env.local
   ├─ Add 4 credentials
   └─ Add to docker-compose.yml

✅ Phase 4: Code Implementation
   ├─ Add imports
   ├─ Add helper functions
   ├─ Add webhook endpoints
   ├─ Add send endpoint
   └─ Integrate with workflows

✅ Phase 5: Testing
   ├─ Webhook verification test
   ├─ Send message test
   ├─ End-to-end order test
   └─ Monitor server logs

✅ Phase 6: Production
   ├─ Update to production URL
   ├─ Configure SSL/HTTPS
   ├─ Monitor message delivery
   └─ Set up alerts
```

---

## Message Template Best Practices

```
Order Status Messages (Approved Templates):

✅ CONFIRMATION
   "Your order #{{order_id}} is confirmed! 🎉
    Items: {{items}}
    Total: ₹{{amount}}"

🍳 PREPARING
   "{{emoji}} Your order is being prepared
    Estimated time: {{eta}}
    We're working on it!"

✅ READY
   "Your order is ready! {{emoji}}
    Table {{table}}
    Staff will serve shortly"

💰 BILLING
   "Bill requested ✅
    Amount: ₹{{amount}}
    Thank you for dining!"

📱 CUSTOM
   "Customer feedback request:
    How was your experience?
    [Link to survey]"
```

---

## Monitoring Dashboard

```
WhatsApp Integration Metrics:

Messages Sent (Last 24h):     12,450
├─ Order Confirmations:       3,200
├─ Preparing Notifications:   5,100
├─ Ready Alerts:              2,800
├─ Bill Requests:             1,200
└─ Other:                       150

Delivery Success Rate:        98.5% ✅
├─ Sent:                    12,450
├─ Delivered:               12,265
├─ Read:                    11,890
└─ Failed:                     185

Average Response Time:        1.2s
├─ Min:                     0.3s
├─ Max:                     8.5s
└─ P95:                     2.1s

API Health:
├─ Status:                  ✅ OK
├─ Last Error:              2h ago
├─ Error Rate:              0.3%
└─ Rate Limit:              250/1000 calls
```

---

This diagram covers the complete flow from setup through production operation!
