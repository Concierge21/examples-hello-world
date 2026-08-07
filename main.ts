// ============================================================
// Pain Rheylief House — Unified Automation Server (Deno Deploy)
// Single Facebook webhook that routes the workflows.
//
// W1: AI Chatbot (Groq + Deno KV memory + booking → Sheets + owner DM)
// W2: Daily 12PM Manila client reminder to owner (Deno.cron)
// W3: Monthly follow-up to all leads, 1st @ 10AM Manila (Deno.cron)
// W4: BUSY/OPEN schedule blocking via page posts (Gemini date parse)
// W6: Weekly educational Reel — Gemini script + on-screen lines,
//     OpenAI TTS voiceover, Cloudinary text + audio overlay,
//     auto-posted to the Page. Mondays 9AM Manila.
//
// NOTE: the old "new page post → auto Reel" workflow has been removed.
// Page posts now only trigger BUSY/OPEN schedule handling.
//
// ENVIRONMENT VARIABLES (Deno Deploy → Project → Settings → Env):
//   FB_PAGE_TOKEN            Facebook Page access token
//   GROQ_API_KEY             Groq API key (gsk_...)
//   GEMINI_API_KEY           Google Gemini API key
//   OPENAI_API_KEY           OpenAI API key (TTS)
//   CLOUDINARY_CLOUD_NAME    Cloudinary cloud name
//   CLOUDINARY_API_KEY       Cloudinary API key
//   CLOUDINARY_API_SECRET    Cloudinary API secret
//   VERIFY_TOKEN             Webhook verify token (painrheylief2026)
//   SHEETS_LEADS_URL         Apps Script URL for saving bookings (W1)
//   SHEETS_DATA_URL          Apps Script URL for reading rows / date blocks
//   OWNER_PSID               Owner's page-scoped ID (7386353388108184)
//   PAGE_ID                  Facebook Page ID (376260662410328)
//   TELEGRAM_BOT_TOKEN       Owner-alert bot token from @BotFather
//   TELEGRAM_CHAT_ID         Owner's Telegram chat ID
// ============================================================
const FB_PAGE_TOKEN = Deno.env.get("FB_PAGE_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "painrheylief2026";
const SHEETS_LEADS_URL = Deno.env.get("SHEETS_LEADS_URL") ?? "";
const SHEETS_DATA_URL = Deno.env.get("SHEETS_DATA_URL") ?? "";
const OWNER_PSID = Deno.env.get("OWNER_PSID") ?? "7386353388108184";
const PAGE_ID = Deno.env.get("PAGE_ID") ?? "376260662410328";
const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "";
const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY") ?? "";
const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
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
// Every owner alert goes through here.
// Telegram has no 24-hour window, so it always lands. Messenger is still
// attempted so he also sees it there whenever that window happens to be open.
async function notifyOwner(text: string): Promise<void> {
  const viaTelegram = await sendTelegram(text);
  const viaMessenger = await sendMessengerText(OWNER_PSID, text);
  if (!viaTelegram && !viaMessenger) {
    console.error("OWNER ALERT NOT DELIVERED on any channel:", text.slice(0, 120));
  }
}
function manilaNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8, no DST
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
  const trimmed = history.slice(-20); // last 10 exchanges
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
        model: "llama-3.3-70b-versatile",
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
    `Extract the specific date or date range from this text and return ONLY a JSON object with no extra text:\nText: '${dateText}'\nToday's date in Philippines time: ${today}\n\nReturn format:\n{"dates": ["Month Day, Year", "Month Day, Year"]}\n\nExamples:\n- 'July 10' -> {"dates": ["July 10, 2026"]}\n- 'bukas' -> {"dates": [next day date]}\n- 'July 10-15' -> {"dates": ["July 10, 2026","July 11, 2026","July 12, 2026","July 13, 2026","July 14, 2026","July 15, 2026"]}\n- 'this week' -> {"dates": [all remaining days this week]}`,
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
// Workflow 3 — Monthly follow-up (1st @ 10AM Manila = 02:00 UTC)
// ------------------------------------------------------------
Deno.cron("monthly lead followup", "0 2 1 * *", async () => {
  if (!SHEETS_DATA_URL) return;
  try {
    const res = await fetch(SHEETS_DATA_URL);
    const rows: Record<string, string>[] = await res.json();
    const leads = rows.filter((row) => {
      const id = row.senderId || row.SenderID || "";
      return id && id.length > 5;
    });
    for (const row of leads) {
      const senderId = row.senderId || row.SenderID;
      const name = row.name || row.Name || "Ka";
      const service = row.service || row.Service || "therapy session";
      await sendMessengerText(
        senderId,
        `Hi ${name}! 🌿 It's been a while since your last session at Pain Rheylief House. Your body might be ready for another ${service}!\n\nWe're open 1PM-8PM daily at The Healthy Hub, Arellano St., Tacloban City.\n\nWant to book again? Just reply here and we'll set it up for you! 😊`,
      );
      await new Promise((r) => setTimeout(r, 2000)); // gentle rate limit
    }
  } catch (e) {
    console.error("Monthly follow-up failed:", e);
  }
});
// ------------------------------------------------------------
// Media pipeline — TTS + Cloudinary
// ------------------------------------------------------------
async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeVoiceover(script: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "nova",
        input: script.slice(0, 4000),
      }),
    });
    if (!res.ok) {
      console.error("TTS failed:", res.status, await res.text());
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.error("TTS error:", e);
    return null;
  }
}
async function cloudinaryUpload(file: string, publicId: string): Promise<string> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = await sha1Hex(toSign);
    const form = new FormData();
    form.set("file", file);
    form.set("api_key", CLOUDINARY_API_KEY);
    form.set("timestamp", String(timestamp));
    form.set("public_id", publicId);
    form.set("signature", signature);
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`,
      { method: "POST", body: form },
    );
    const data = await res.json();
    if (!res.ok) {
      console.error("Cloudinary upload failed:", JSON.stringify(data).slice(0, 300));
      return "";
    }
    return data.public_id ?? "";
  } catch (e) {
    console.error("Cloudinary upload error:", e);
    return "";
  }
}
function bytesToDataUri(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/mp3;base64,${btoa(binary)}`;
}
// ------------------------------------------------------------
// Workflow 6 — Weekly educational Reel (Mondays 9AM Manila = 01:00 UTC)
// ------------------------------------------------------------
const ANATOMY_CLIPS: Record<string, string[]> = {
  "lower back": ["anat_back_1", "anat_back_2"],
  "upper back": ["anat_back_1", "anat_back_2"],
  "neck": ["anat_neck_1"],
  "shoulders": ["anat_shoulder_1"],
  "knees": ["anat_knee_1"],
  "hips": ["anat_hip_1"],
  "wrists": ["anat_wrist_1"],
  "ankles": ["anat_ankle_1"],
  "jaw": ["anat_jaw_1"],
  "elbows": ["anat_elbow_1"],
};
function pickClipFor(bodyPart: string): string {
  const key = bodyPart.toLowerCase().trim();
  const list = ANATOMY_CLIPS[key] ?? Object.values(ANATOMY_CLIPS).flat();
  return list[Math.floor(Math.random() * list.length)];
}
async function buildReel(clipId: string, script: string, lines: string[]): Promise<string> {
  const audioBytes = await makeVoiceover(script);
  if (!audioBytes) return "";
  const audioId = await cloudinaryUpload(bytesToDataUri(audioBytes), `vo_${Date.now()}`);
  if (!audioId) return "";
  const clean = (s: string) =>
    encodeURIComponent(s.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 55));
  const span = 25 / Math.max(lines.length, 1);
  let textChain = "";
  lines.forEach((line, i) => {
    const start = Math.round(i * span);
    const end = Math.round((i + 1) * span);
    textChain +=
      `l_text:Arial_62_bold:${clean(line)},co_white,b_rgb:000000B3,g_south,y_300,w_900,c_fit,so_${start},eo_${end}/fl_layer_apply/`;
  });
  const merged =
    `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/c_fill,h_1920,w_1080/${textChain}ac_none/l_audio:${audioId}/fl_layer_apply/${clipId}.mp4`;
  console.log("Weekly Reel URL:", merged);
  try { await fetch(merged); } catch { /* ignore */ }
  return merged;
}
async function weeklyAnatomyReel() {
  const parsed = await geminiJson(
    `Create a weekly educational Reel for Pain Rheylief House, a pain relief clinic in Tacloban City, Philippines.\n\nPick ONE body part from this list: lower back, neck, shoulders, knees, hips, wrists, upper back, ankles, jaw, elbows.\n\nRespond ONLY with valid JSON. No markdown, no backticks. Every field a non-empty string:\n{\n  "body_part": "the part you chose",\n  "script": "25-second English voiceover: (1) hook question about that pain, (2) what that body part actually does, (3) the most common cause of pain there, (4) ONE simple stretch or movement a person can do at home to relieve it, described step by step with how long to hold it, (5) end with: For lasting relief, visit Pain Rheylief House at The Healthy Hub, Arellano Street, Tacloban City. Open 1PM to 8PM daily. Message us to book a consultation.",\n  "text_lines": ["4 to 6 on-screen lines, max 6 words each, following the voiceover order: hook, cause, the movement, how long to hold, why it helps, invitation to message"],\n  "caption": "English caption under 150 characters naming the body part and the tip, one emoji, invites a consultation"\n}\n\nCONTENT RULES:\n- EDUCATIONAL only. NEVER mention prices, rates, packages, peso amounts, or promos.\n- Explain the anatomy in plain language a non-medical reader understands.\n- The movement must be safe and general — stretching, posture, heat, rest. Never diagnose.\n- ENGLISH ONLY. No Tagalog, no Taglish.`,
  );
  const bodyPart = (parsed.body_part as string) || "lower back";
  const script = (parsed.script as string) || "";
  const rawCaption = (parsed.caption as string) ?? "";
  const caption = rawCaption.trim() && rawCaption.trim() !== "undefined"
    ? rawCaption.trim()
    : "Your body deserves to heal. Message us for a consultation. 💆";
  console.log("Weekly Reel — body part:", bodyPart);
  if (!script) {
    console.error("Weekly Reel: no script from Gemini");
    return;
  }
  const rawLines = parsed.text_lines;
  const lines = Array.isArray(rawLines) && rawLines.length
    ? (rawLines as string[])
    : ["Body pain slowing you down", "Try this simple stretch", "Hold for 20 seconds", "Message us for a consultation"];
  const voicedUrl = await buildReel(pickClipFor(bodyPart), script, lines);
  if (!voicedUrl) {
    console.error("Weekly Reel: merge failed");
    return;
  }
  const hashtags =
    "#PainRelief #MassageTherapy #PainRheyliefHouse #TaclobanCity #BodyPain #PainFree #WellnessPh";
  const form = new URLSearchParams();
  form.set("access_token", FB_PAGE_TOKEN);
  form.set("description", `${caption}\n\n${hashtags}`);
  form.set("file_url", voicedUrl);
  const res = await fetch(`${GRAPH}/${PAGE_ID}/videos`, { method: "POST", body: form });
  const ok = res.ok;
  if (!ok) console.error("Weekly Reel post failed:", res.status, await res.text());
  await notifyOwner(
    ok ? `🎬 Weekly Reel posted — ${bodyPart}\n\n📝 ${caption}` : `⚠️ Weekly Reel failed. Check logs.`,
  );
}
Deno.cron("weekly anatomy reel", "0 1 * * 1", weeklyAnatomyReel);
// ------------------------------------------------------------
// Main webhook server — single endpoint, routes by payload
// ------------------------------------------------------------
async function processEvents(body: Record<string, unknown>) {
  console.log("RAW PAYLOAD:", JSON.stringify(body).slice(0, 500));
  const entries = (body.entry as Record<string, unknown>[]) ?? [];
  for (const entry of entries) {
    // ---- Messenger events → Workflow 1 ----
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
    // ---- Feed events → Workflow 4 only (BUSY / OPEN) ----
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
      // Only BUSY / OPEN posts do anything. All other posts are ignored.
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
    const msg = "✅ Test alert from Pain RHEYlief House automation.";
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
  if (url.pathname === "/test-weekly") {
    await weeklyAnatomyReel();
    return new Response("Weekly Reel fired — check the Page and logs");
  }
  if (url.pathname !== "/webhook") {
    return new Response("Not found", { status: 404 });
  }
  // Facebook webhook verification handshake
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
    // Respond to Facebook immediately; keep processing in the background
    queueMicrotask(() => {
      processEvents(body).catch((e) => console.error("Event processing error:", e));
    });
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
  return new Response("Method not allowed", { status: 405 });
});
