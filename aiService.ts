/**
 * Atithi Setu — AI service (Groq)
 *
 * Uses the Groq cloud API for:
 *   • In-room concierge chatbot (fast Llama 3.1 8B for sub-second latency)
 *   • On-demand guest-feedback sentiment analysis (Llama 3.1 70B for quality)
 *
 * Env var required:
 *   GROQ_API_KEY
 *
 * Groq endpoints are OpenAI-compatible so we use fetch directly — no SDK dep.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

async function callGroq(messages: ChatMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; responseFormat?: 'json_object' | 'text' } = {}): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured on the server');
  }
  const body: any = {
    model: opts.model || 'llama-3.1-8b-instant',
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 500,
  };
  if (opts.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Concierge chat ──────────────────────────────────────────────────────

export interface ConciergeChatInput {
  hotelName: string;
  city?: string;
  faqs: Array<{ question: string; answer: string }>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
  guestName?: string;
}

export async function chatWithConcierge(input: ConciergeChatInput): Promise<string> {
  const faqBlock = input.faqs.length > 0
    ? input.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : '(No FAQ entries configured yet — answer from general knowledge about hotels.)';

  const systemPrompt = `You are the digital concierge for **${input.hotelName}**${input.city ? ` in ${input.city}` : ''}.
You assist guests staying at the property via an in-room chat.

Style:
• Warm, concise, professional — like a boutique hotel concierge.
• Keep replies under 4 sentences unless the guest asks for detailed info.
• If you don't know a specific hotel detail (WiFi password, pool hours, specific menu items), say so and recommend the guest submit a Service Request or call the front desk.
• Never invent specific facts (prices, phone numbers, schedules) not provided in the FAQ or the conversation.
• Always respond in the guest's language if they write in something other than English.

Hotel FAQ / Knowledge base:
${faqBlock}

${input.guestName ? `You're chatting with ${input.guestName}.` : ''}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...input.history.map(h => ({ role: h.role, content: h.content } as ChatMessage)),
    { role: 'user', content: input.message },
  ];

  return await callGroq(messages, { model: 'llama-3.1-8b-instant', temperature: 0.5, maxTokens: 400 });
}

// ─── Sentiment analysis ──────────────────────────────────────────────────

export interface SentimentInput {
  hotelName: string;
  feedbackItems: Array<{
    id: string;
    serviceName: string;
    category?: string;
    rating?: number | null;
    roomName?: string;
    feedback: string;
    at: string;
  }>;
}

export interface SentimentResult {
  summary: string;              // 2-3 sentence executive summary
  overall_score: number;        // -1 (all negative) to +1 (all positive)
  breakdown: {
    positive: number;           // count of positive items
    neutral:  number;
    negative: number;
  };
  patterns: Array<{
    theme: string;              // e.g. "AC cooling"
    severity: 'low' | 'medium' | 'high';
    evidence: string;           // e.g. "3 guests on floor 3 mentioned"
    suggestion: string;         // e.g. "Inspect AC on floor 3"
  }>;
  items: Array<{
    id: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    reason: string;             // one-line explanation
  }>;
}

export async function analyzeSentiment(input: SentimentInput): Promise<SentimentResult> {
  const maxItems = input.feedbackItems.slice(0, 50);
  const itemsJson = JSON.stringify(
    maxItems.map(it => ({
      id: it.id,
      service: it.serviceName,
      category: it.category,
      rating: it.rating ?? null,
      room: it.roomName,
      text: it.feedback.slice(0, 400),
    })),
    null, 2
  );

  const systemPrompt = `You analyze guest-feedback data for a hotel. Be objective, actionable, and concise.

You will receive a JSON array of feedback items from guests at ${input.hotelName}. You must respond with ONE JSON object, nothing else, matching this schema exactly:

{
  "summary": "2-3 sentences describing the overall state of guest experience",
  "overall_score": -1.0 to 1.0,
  "breakdown": { "positive": N, "neutral": N, "negative": N },
  "patterns": [
    {
      "theme": "short label (e.g. 'AC cooling')",
      "severity": "low" | "medium" | "high",
      "evidence": "which items/rooms show this pattern",
      "suggestion": "one concrete action the operator can take"
    }
  ],
  "items": [
    { "id": "<item id>", "sentiment": "positive"|"neutral"|"negative", "reason": "one line" }
  ]
}

Rules:
• Only include a pattern if 2+ items share the theme, OR a single item is severe (health/safety/security).
• patterns must be actionable — avoid generic "improve service" advice.
• Keep items array aligned with input order; every input id must have an entry.
• severity: "high" for safety or repeated severe complaints, "medium" for repeated minor issues, "low" otherwise.`;

  const userPrompt = `Analyze the following ${maxItems.length} feedback items:\n\n${itemsJson}`;

  const raw = await callGroq(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    { model: 'llama-3.1-70b-versatile', temperature: 0.2, maxTokens: 2000, responseFormat: 'json_object' }
  );

  try {
    const parsed = JSON.parse(raw) as SentimentResult;
    // Basic sanity defaults
    if (typeof parsed.summary !== 'string') parsed.summary = 'Analysis unavailable.';
    if (!parsed.breakdown) parsed.breakdown = { positive: 0, neutral: 0, negative: 0 };
    if (!Array.isArray(parsed.patterns)) parsed.patterns = [];
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (typeof parsed.overall_score !== 'number') parsed.overall_score = 0;
    return parsed;
  } catch (err) {
    console.error('Failed to parse sentiment JSON:', err, raw.slice(0, 300));
    // Fallback — return an empty result instead of crashing
    return {
      summary: 'Sentiment analysis returned a malformed response; please try again.',
      overall_score: 0,
      breakdown: { positive: 0, neutral: 0, negative: 0 },
      patterns: [],
      items: [],
    };
  }
}
