// ============================================================
// Pain Rheylief House — Unified Automation Server (Deno Deploy)
// Single Facebook webhook that routes the workflows.
// ============================================================
const FB_PAGE_TOKEN = Deno.env.get("FB_PAGE_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "painrheylief2026";
const SHEETS_LEADS_URL = Deno.env.get("SHEETS_LEADS_URL") ?? "";
const SHEETS_DATA_URL = Deno.env.get("SHEETS_DATA_URL") ?? "";
const OWNER_PSID = Deno.env.get("OWNER_PSID") ?? "7386353388108184";
const PAGE_ID = Deno.env.get("PAGE_ID") ?? "376260662410328";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const kv = await Deno.openKv();
const GRAPH = "https://graph.facebook.com/v19.0";

// ------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------
async function sendMessengerText(recipientId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${FB_PAGE_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    });
    if (!res.ok) console.error("Messenger send failed:", res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error("Messenger send error:", e);
    return false;
  }
}

async function sendTelegram(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      },
    );
    if (!res.ok) console.error("Telegram send failed:", res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error("Telegram send error:", e);
    return false;
  }
}

async function notifyOwner(text: string): Promise<void> {
  const viaTelegram = await sendTelegram(text);
  const viaMessenger = await sendMessengerText(OWNER_PSID, text);
  if (!viaTelegram && !viaMessenger) {
    console.error("OWNER ALERT NOT DELIVERED on any channel:", text.slice(0, 120));
  }
}

function manilaNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
}

function manilaDateStrings(d: Date) {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const long = `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const short = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  return { long, short };
}

async function seenBefore(key: string, ttlMs: number): Promise<boolean> {
  const k = ["seen", key];
  const existing = await kv.get(k);
  if (existing.value) return true;
  await kv.set(k, true, { expireIn: ttlMs });
  return false;
}

async function geminiJson(prompt: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) {
      console.error("Gemini error:", res.status, await res.text());
      return {};
    }
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Gemini parse error:", e);
    return {};
  }
}

// ------------------------------------------------------------
// Workflow 1 — AI Chatbot
// ------------------------------------------------------------
const SYSTEM_PROMPT = `You are a warm and friendly AI assistant for Pain Rheylief House, a professional massage and pain relief therapy clinic in Tacloban City, Philippines.
Address: The Healthy Hub, Arellano St., Tacloban City
Phone: 09461331411
Hours: 1PM to 8PM, Monday to Sunday
Services:
- AP Alignment - 30mins - P1200
- Deep Tissue Therapy - 30mins - P1000
- Body Electro Acupuncture - 30mins - P350
- Foot Electro Acupuncture - 30mins - P250
- Vital Harmony - 60mins - P1200
- Restore and Realign - 60mins - P1850
- Total Reboot Therapy - 120mins - P2150
Promo Packages (8 sessions each, includes free Magnesium oil spray and tallow balm):
- Restore and Realign - P12000
- Restore and Realign with Foot Electro - P13600
- Vital Harmony with AP Alignment - P14000
- Total Reboot Therapy - P14800
Payment via UnionBank and InstaPay.
Ask English or Tagalog preference first, only if this is a new conversation. Reply in the chosen language only for the rest of the conversation. Remember what the client has already told you (language, service, name, date, time) and do not ask again for information already given.
Show prices when asked. Collect name, service, date, and time. Confirm booking with the address and phone number.
Keep replies short, suitable for Messenger.
CRITICAL BOOKING RULE:
Only add the booking tag when you have ALL FOUR of these from the client: their real name, the service, the date, and the time. If any one is missing, ask for it and do NOT add the tag. Never invent, guess, or use a placeholder for the name — never write things like "Hindi pa nakumpirma", "unknown", "client", or "N/A". The name must be one the client actually typed.
When and only when all four are confirmed, add this exact tag at the end of your reply: [BOOKING_CONFIRMED: name=NAME, service=SERVICE, date=DATE, time=TIME]`;

type ChatMsg = { role: "user" | "assistant"; content: string };

async function getHistory(senderId: string): Promise<ChatMsg[]> {
  const entry = await kv.get<ChatMsg[]>(["chat_history", senderId]);
  return entry.value ?? [];
}

async function saveHistory(senderId: string, history: ChatMsg[]) {
  const trimmed = history.slice(-20);
  await kv.set(["chat_history", senderId], trimmed, {
    expireIn: 7 * 24 * 60 * 60 * 1000,
  });
}

async function groqChat(history: ChatMsg[], userMessage: string): Promise<string> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: userMessage },
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });
    if (!res.ok) {
      console.error("Groq error:", res.status, await res.text());
      return "Sorry, please try again.";
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "Sorry, please try again.";
  } catch (e) {
    console.error("Groq request error:", e);
    return "Sorry, please try again.";
  }
}

async function handleChatMessage(senderId: string, messageText: string) {
  const history = await getHistory(senderId);
  const rawReply = await groqChat(history, messageText);
  const bookingMatch = rawReply.match(
    /\[BOOKING_CONFIRMED: name=(.+?), service=(.+?), date=(.+?), time=(.+?)\]/,
  );
  const cleanReply = rawReply.replace(/\[BOOKING_CONFIRMED:.*?\]/g, "").trim();
  history.push({ role: "user", content: messageText });
  history.push({ role: "assistant", content: rawReply });
  await saveHistory(senderId, history);
  await sendMessengerText(senderId, cleanReply);
  if (bookingMatch) {
    const [, name, service, date, time] = bookingMatch;
    const fbLink = `https://www.facebook.com/profile.php?id=${senderId}`;
    if (SHEETS_LEADS_URL) {
      await fetch(SHEETS_LEADS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, service, date, time, fb_link: fbLink, senderId }),
      }).catch((e) => console.error("Sheets save failed:", e));
    }
    await notifyOwner(
      `🌿 New Booking!\n👤 ${name}\n💆 ${service}\n📅 ${date}\n🕒 ${time}`,
    );
  }
}

// ------------------------------------------------------------
// Workflow 4 — BUSY/OPEN schedule blocking
// ------------------------------------------------------------
async function handleScheduleCommand(postMessage: string) {
  const isBusy = postMessage.toUpperCase().startsWith("BUSY");
  const action = isBusy ? "BUSY" : "OPEN";
  const dateText = postMessage.replace(/^(BUSY|OPEN)\s*/i, "").trim();
  const { long: today } = manilaDateStrings(manilaNow());
  const parsed = await geminiJson(
    `Extract the specific date or date range from this text and return ONLY a JSON object with no extra text:\nText: '${dateText}'\nToday's date in Philippines time: ${today}\n\nReturn format:\n{"dates": ["Month Day, Year", "Month Day, Year"]}`,
  );
  const dates: string[] = Array.isArray(parsed.dates) ? (parsed.dates as string[]) : [];
  if (SHEETS_DATA_URL) {
    for (const date of dates) {
      await fetch(SHEETS_DATA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "block_date", date, action }),
      }).catch((e) => console.error("Block date save failed:", e));
    }
  }
  await notifyOwner(
    `✅ Schedule updated!\n${action === "BUSY" ? "🔴 BLOCKED" : "🟢 OPENED"}: ${dateText}\n\nThe chatbot will automatically handle bookings for these dates.`,
  );
}

// ------------------------------------------------------------
// Workflow 2 — Daily 12PM Manila reminder (04:00 UTC)
// ------------------------------------------------------------
async function dailyClientReminder() {
  if (!SHEETS_DATA_URL) return;
  try {
    const res = await fetch(SHEETS_DATA_URL);
    const rows: Record<string, string>[] = await res.json();
    const now = manilaNow();
    const { long, short } = manilaDateStrings(now);
    const todayClients = rows.filter((row) => {
      const dateCell = row.date || row.Date || "";
      return dateCell.includes(long) || dateCell.includes(short) || dateCell === long;
    });
    if (todayClients.length === 0) return;
    let message = "🌿 Pain Rheylief House\n📅 Clients for Today:\n\n";
    todayClients.forEach((client, i) => {
      message += `${i + 1}. 👤 ${client.name || client.Name}\n`;
      message += `   💆 ${client.service || client.Service}\n`;
      message += `   🕒 ${client.time || client.Time}\n\n`;
    });
    message += "Good luck today! 💪";
    await notifyOwner(message);
  } catch (e) {
    console.error("Daily reminder failed:", e);
  }
}
Deno.cron("daily client reminder", "0 4 * * *", dailyClientReminder);

// ------------------------------------------------------------
// Main webhook server
// ------------------------------------------------------------
async function processEvents(body: Record<string, unknown>) {
  console.log("RAW PAYLOAD:", JSON.stringify(body).slice(0, 500));
  const entries = (body.entry as Record<string, unknown>[]) ?? [];
  for (const entry of entries) {
    const messagingEvents = (entry.messaging as Record<string, unknown>[]) ?? [];
    for (const ev of messagingEvents) {
      const message = ev.message as Record<string, unknown> | undefined;
      const sender = ev.sender as Record<string, unknown> | undefined;
      if (!message || message.is_echo) continue;
      const senderId = String(sender?.id ?? "");
      const messageText = String(message.text ?? "");
      const mid = String(message.mid ?? "");
      if (!senderId || senderId === PAGE_ID || !messageText) continue;
      if (mid && (await seenBefore(`mid_${mid}`, 60 * 60 * 1000))) continue;
      await handleChatMessage(senderId, messageText);
    }
    const changes = (entry.changes as Record<string, unknown>[]) ?? [];
    for (const change of changes) {
      if (change.field !== "feed") continue;
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;
      const verb = String(value.verb ?? "");
      const item = String(value.item ?? "");
      const blockedVerbs = ["edited", "delete", "remove", "unlike", "hide"];
      if (blockedVerbs.includes(verb)) continue;
      const blockedItems = ["comment", "like", "reaction", "friendship", "mention"];
      if (item && blockedItems.includes(item)) continue;
      const postMessage = String(value.message ?? value.story ?? "");
      if (!postMessage) continue;
      const upper = postMessage.toUpperCase();
      if (!upper.startsWith("BUSY") && !upper.startsWith("OPEN")) continue;
      const postId = String(value.post_id ?? "");
      const dedupKey = postId || postMessage.slice(0, 50);
      if (dedupKey && (await seenBefore(`feed_${dedupKey}`, 24 * 60 * 60 * 1000))) continue;
      await handleScheduleCommand(postMessage);
    }
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/" && req.method === "GET") {
    return new Response("Pain Rheylief automation server is running 🌿", { status: 200 });
  }
  if (url.pathname === "/telegram-chatid") {
    if (!TELEGRAM_BOT_TOKEN) return new Response("TELEGRAM_BOT_TOKEN not set yet");
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
    const data = await res.json();
    const ids: string[] = (data.result ?? [])
      .map((u: Record<string, any>) => u.message?.chat)
      .filter(Boolean)
      .map((c: Record<string, any>) => `${c.first_name ?? "?"} => ${c.id}`);
    return new Response(
      ids.length
        ? `Chat IDs found:\n${[...new Set(ids)].join("\n")}\n\nPut the number into TELEGRAM_CHAT_ID.`
        : "No messages yet. Have him open t.me/Rheylief_bot and press START, then reload this page.",
    );
  }
  if (url.pathname === "/test-owner") {
    const msg = "✅ Test alert from Pain Rheylief House automation.";
    const tg = await sendTelegram(msg);
    const fb = await sendMessengerText(OWNER_PSID, msg);
    return new Response(
      `Telegram : ${tg ? "DELIVERED" : "failed / not configured yet"}\n` +
      `Messenger: ${fb ? "DELIVERED" : "failed (expected — the 24h window)"}\n\n` +
      `Telegram is the one that must say DELIVERED.`,
    );
  }
  if (url.pathname === "/test-reminder") {
    await dailyClientReminder();
    return new Response("Reminder fired — check Messenger and Deno logs");
  }
  if (url.pathname === "/reset-chat") {
    const sid = url.searchParams.get("id") ?? "";
    if (!sid) return new Response("Missing ?id=");
    await kv.delete(["chat_history", sid]);
    return new Response(`Chat history cleared for ${sid}`);
  }
  if (url.pathname !== "/webhook") {
    return new Response("Not found", { status: 404 });
  }
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    queueMicrotask(() => {
      processEvents(body).catch((e) => console.error("Event processing error:", e));
    });
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
  return new Response("Method not allowed", { status: 405 });
});
