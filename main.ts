// ============================================================
// Pain Rheylief House — Unified Automation Server (Deno Deploy)
// Single Facebook webhook that routes all 5 workflows.
//
// W1: AI Chatbot (Groq + Deno KV memory + booking → Sheets + owner DM)
// W2: Daily 12PM Manila client reminder to owner (Deno.cron)
// W3: Monthly follow-up to all leads, 1st @ 10AM Manila (Deno.cron)
// W4: BUSY/OPEN schedule blocking via page posts (Gemini date parse)
// W5: New page post → Gemini script/caption/hashtags → Pexels video
//     → auto-posts a Reel via public file_url + DMs owner the
//     voiceover kit. (FFmpeg merging/voiceover baking is not possible
//     on serverless — this posts a single stock clip instead.)
//
// ENVIRONMENT VARIABLES (Deno Deploy → Project → Settings → Env):
//   FB_PAGE_TOKEN     Facebook Page access token
//   GROQ_API_KEY      Groq API key (gsk_...)
//   GEMINI_API_KEY    Google Gemini API key
//   PEXELS_API_KEY    Pexels API key
//   VERIFY_TOKEN      Webhook verify token (painrheylief2026)
//   SHEETS_LEADS_URL  Apps Script URL for saving bookings (W1)
//   SHEETS_DATA_URL   Apps Script URL for reading rows / date blocks (W2-W4)
//   OWNER_PSID        Owner's page-scoped ID (7386353388108184)
//   PAGE_ID           Facebook Page ID (376260662410328)
// ============================================================

const FB_PAGE_TOKEN = Deno.env.get("FB_PAGE_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const PEXELS_API_KEY = Deno.env.get("PEXELS_API_KEY") ?? "";
const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "painrheylief2026";
const SHEETS_LEADS_URL = Deno.env.get("SHEETS_LEADS_URL") ?? "";
const SHEETS_DATA_URL = Deno.env.get("SHEETS_DATA_URL") ?? "";
const OWNER_PSID = Deno.env.get("OWNER_PSID") ?? "7386353388108184";
const PAGE_ID = Deno.env.get("PAGE_ID") ?? "376260662410328";

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

If booking is confirmed, add this exact tag at the end of your reply: [BOOKING_CONFIRMED: name=NAME, service=SERVICE, date=DATE, time=TIME]`;

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

    // Best-effort owner alert (may fail outside the 24h window — non-fatal)
    await sendMessengerText(
      OWNER_PSID,
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

  await sendMessengerText(
    OWNER_PSID,
    `✅ Schedule updated!\n${action === "BUSY" ? "🔴 BLOCKED" : "🟢 OPENED"}: ${dateText}\n\nThe chatbot will automatically handle bookings for these dates.`,
  );
}

// ------------------------------------------------------------
// Workflow 5 — New post → auto Reel (single clip) + owner kit
// ------------------------------------------------------------

async function pickPexelsVideoUrl(keyword: string): Promise<string> {
  if (!PEXELS_API_KEY) return "";
  try {
    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=3&orientation=portrait&size=medium`,
      { headers: { Authorization: PEXELS_API_KEY } },
    );
    if (!res.ok) {
      console.error("Pexels error:", res.status, await res.text());
      return "";
    }
    const data = await res.json();
    const videos = data.videos ?? [];
    for (const v of videos) {
      const files = v.video_files ?? [];
      const portraitHd = files.find((f: { height: number; width: number; quality: string }) =>
        f.height > f.width && f.quality === "hd"
      );
      const anyPortrait = files.find((f: { height: number; width: number }) =>
        f.height > f.width
      );
      const chosen = portraitHd || anyPortrait || files[0];
      if (chosen?.link) return chosen.link as string;
    }
    return "";
  } catch (e) {
    console.error("Pexels request error:", e);
    return "";
  }
}

async function handleNewPost(postMessage: string) {
  const parsed = await geminiJson(
    `You are a content creator for Pain Rheylief House, a massage and pain relief therapy clinic in Tacloban City, Philippines.\n\nBased on this Facebook post: '${postMessage}'\n\nRespond ONLY with a valid JSON object (no markdown, no backticks, no extra text):\n{\n  "pexels_keyword": "short 2-3 word search term for anatomy or pain relief video (example: back pain massage, neck pain relief, spine anatomy)",\n  "script": "Write a 30-second educational voiceover script about the pain topic in this post. Structure: First 5 seconds hook question. Next 15 seconds explain the pain cause and one simple tip to relieve it. Last 10 seconds say: For professional pain relief, visit Pain Rheylief House at The Healthy Hub, Arellano Street, Tacloban City. Open 1PM to 8PM daily. Message us on Facebook to book your session today!",\n  "caption": "Engaging Facebook Reel caption under 150 characters with one relevant emoji",\n  "hashtags": "#PainRelief #MassageTherapy #PainRheyliefHouse #TaclobanCity #BackPain #MassagePh #PainManagement #DeepTissue #HilotPh #NaturalHealing #BodyPain #MassageHeals #TaclobanMassage #PainFree #WellnessPh"\n}`,
  );

  const keyword = (parsed.pexels_keyword as string) ?? "massage therapy pain relief";
  console.log("W5 fired — keyword:", keyword, "caption:", parsed.caption);
  const script = (parsed.script as string) ??
    "Is your body in pain? At Pain Rheylief House, our expert therapists provide professional pain relief treatments. Visit us at The Healthy Hub, Arellano Street, Tacloban City. Open 1PM to 8PM daily. Message us on Facebook to book your session today!";
  const caption = (parsed.caption as string) ??
    "Professional pain relief is just one session away! 💆";
  const hashtags = (parsed.hashtags as string) ??
    "#PainRelief #MassageTherapy #PainRheyliefHouse #TaclobanCity";

  // Try to auto-post a Reel using a public Pexels video URL
  const videoUrl = await pickPexelsVideoUrl(keyword);
  let posted = false;

  if (videoUrl) {
    try {
      const form = new URLSearchParams();
      form.set("access_token", FB_PAGE_TOKEN);
      form.set("description", `${caption} ${hashtags}`);
      form.set("file_url", videoUrl);

      const res = await fetch(`${GRAPH}/${PAGE_ID}/videos`, {
        method: "POST",
        body: form,
      });
      posted = res.ok;
      if (!res.ok) console.error("Reel post failed:", res.status, await res.text());
    } catch (e) {
      console.error("Reel post error:", e);
    }
  }

  // Always DM the owner the full content kit
  const statusLine = posted
    ? "✅ A video Reel was auto-posted to the Page with this caption!"
    : "⚠️ Auto-post didn't go through — you can post manually with this kit:";

  await sendMessengerText(
    OWNER_PSID,
    `🎬 Reel Kit for your new post!\n${statusLine}\n\n📝 CAPTION:\n${caption}\n\n🏷️ HASHTAGS:\n${hashtags}\n\n🎙️ VOICEOVER SCRIPT (for a custom version later):\n${script}`,
  );
}

// ------------------------------------------------------------
// Workflow 2 — Daily 12PM Manila reminder (04:00 UTC)
// ------------------------------------------------------------

Deno.cron("daily client reminder", "0 4 * * *", async () => {
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

    await sendMessengerText(OWNER_PSID, message);
  } catch (e) {
    console.error("Daily reminder failed:", e);
  }
});

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
// Main webhook server — single endpoint, routes by payload
// ------------------------------------------------------------

async function processEvents(body: Record<string, unknown>) {
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

    // ---- Feed events → Workflow 4 or 5 ----
    const changes = (entry.changes as Record<string, unknown>[]) ?? [];
    for (const change of changes) {
      if (change.field !== "feed") continue;
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;

      // Only NEW posts — skip edits, deletes, likes, comments, reactions
      const verb = String(value.verb ?? "");
      const item = String(value.item ?? "");

      // Accept "add" or "publish" — Facebook uses both for new posts
      // Also accept empty verb since some post types omit it
      const blockedVerbs = ["edited", "delete", "remove", "unlike", "hide"];
      if (blockedVerbs.includes(verb)) continue;

      // Block comments, likes, reactions — allow posts, shares, photos, videos, empty
      const blockedItems = ["comment", "like", "reaction", "friendship", "mention"];
      if (item && blockedItems.includes(item)) continue;

      const postMessage = String(value.message ?? value.story ?? "");
      if (!postMessage) continue;

      const postId = String(value.post_id ?? "");
      if (postId && (await seenBefore(`post_${postId}`, 24 * 60 * 60 * 1000))) continue;

      const upper = postMessage.toUpperCase();
      if (upper.startsWith("BUSY") || upper.startsWith("OPEN")) {
        await handleScheduleCommand(postMessage); // Workflow 4
      } else {
        await handleNewPost(postMessage); // Workflow 5
      }
    }
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    return new Response("Pain Rheylief automation server is running 🌿", { status: 200 });
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

