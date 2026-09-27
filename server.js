import express from "express";
import cors from "cors";
import { BOT_SYSTEM_PROMPT } from "./bot-prompt.js";

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const INSTAGRAM_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || "profitgift2026";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-5383669717";
const META_APP_ID = process.env.META_APP_ID || "228364487581508";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const RAILWAY_URL = process.env.RAILWAY_URL || `http://localhost:${PORT}`;

// ═══════════════════════════════════════════════════════════
//  CONSTANTS & ANTI-DUPLICATE STATE
// ═══════════════════════════════════════════════════════════

const SERVER_START_TIME = Date.now();
const ECHO_GRACE_PERIOD = 10000;
const MESSAGE_BATCH_DELAY = 5000;
const MESSAGE_ID_TTL = 600000;
const SEND_DEDUP_TTL = 30000;
const HUMAN_TAKEOVER_TTL = 2 * 60 * 60 * 1000;
const SHARE_RESPONSE_COOLDOWN = 60000;
const CONVERSATION_TTL = 24 * 60 * 60 * 1000;
const MAX_CONVERSATION_MESSAGES = 40;
const FOLLOWUP_DELAY_1 = 40 * 60 * 1000;

const BOT_IDS = new Set();
const processedMessageIds = new Set();
const recentSentMessages = new Map();
const botSentMessageIds = new Set();
const botSentTexts = new Map();
const messageQueues = new Map();
const conversations = new Map();
const humanTakeover = new Map();
const lastShareResponse = new Map();
const followupTimers = new Map();
const lastTelegramNotify = new Map();
const TELEGRAM_NOTIFY_COOLDOWN = 2 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    bot: "Profit Gift Instagram Bot",
    uptime: Math.round((Date.now() - SERVER_START_TIME) / 1000) + "s",
    instagram: INSTAGRAM_ACCESS_TOKEN ? "configured" : "NOT SET",
    claude: ANTHROPIC_API_KEY ? "configured" : "NOT SET",
  });
});

// ═══════════════════════════════════════════════════════════
//  TELEGRAM NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("[Telegram] Notification failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  FETCH BOT'S OWN INSTAGRAM ID
// ═══════════════════════════════════════════════════════════

async function fetchBotId() {
  if (!INSTAGRAM_ACCESS_TOKEN) return;
  try {
    const res = await fetch(
      `https://graph.instagram.com/v26.0/me?fields=id,username&access_token=${INSTAGRAM_ACCESS_TOKEN}`
    );
    const data = await res.json();
    if (data.id) {
      BOT_IDS.add(data.id);
      console.log(`[Bot] Instagram ID: ${data.id} (@${data.username || "?"})`);
    }
  } catch (err) {
    console.error("[Bot] Failed to fetch bot ID:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  SANITIZE BOT RESPONSE
// ═══════════════════════════════════════════════════════════

function sanitizeBotResponse(text) {
  if (!text) return text;
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/\*(.*?)\*/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/^[-*]\s+/gm, "• ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ═══════════════════════════════════════════════════════════
//  FOLLOW-UP REMINDERS
// ═══════════════════════════════════════════════════════════

function cancelFollowup(senderId) {
  const timer = followupTimers.get(senderId);
  if (timer) {
    clearTimeout(timer);
    followupTimers.delete(senderId);
    console.log(`[Followup] Cancelled for ${senderId}`);
  }
}

function scheduleFollowup(senderId, botResponse) {
  cancelFollowup(senderId);

  const needsFollowup =
    /доставк|оплат|оформ|замовлен|місто/i.test(botResponse) ||
    /який варіант|розглянете|ближче/i.test(botResponse);

  if (!needsFollowup) return;

  const timer = setTimeout(async () => {
    followupTimers.delete(senderId);
    const takeoverTime = humanTakeover.get(senderId);
    if (takeoverTime && Date.now() - takeoverTime < HUMAN_TAKEOVER_TTL) return;

    console.log(`[Followup] Sending reminder to ${senderId}`);
    await sendInstagramMessage(
      senderId,
      "Привіт! 😊 Нагадую про нашу розмову — може, є якісь питання? Із задоволенням підкажу!"
    );
    sendTelegramNotification(
      `⏰ <b>Follow-up надіслано</b>\nКлієнт: ${senderId}\nБот нагадав після 40 хв тиші`
    );
  }, FOLLOWUP_DELAY_1);

  followupTimers.set(senderId, timer);
}

// ═══════════════════════════════════════════════════════════
//  VOICE TRANSCRIPTION (OpenAI Whisper — optional)
// ═══════════════════════════════════════════════════════════

async function transcribeAudio(audioUrl) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  if (!OPENAI_API_KEY) {
    console.log("[Whisper] No OpenAI key for transcription");
    return null;
  }
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) return null;
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/mp4" }), "voice.m4a");
    formData.append("model", "whisper-1");
    formData.append("language", "uk");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });
    const data = await res.json();
    return data.text || null;
  } catch (err) {
    console.error("[Whisper] Transcription failed:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  IMAGE DOWNLOAD FOR VISION
// ═══════════════════════════════════════════════════════════

async function downloadImageAsBase64(imageUrl) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const base64 = buffer.toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error("[Image] Download failed:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  CLAUDE API (Anthropic)
// ═══════════════════════════════════════════════════════════

async function callClaude(conversationMessages) {
  if (!ANTHROPIC_API_KEY) {
    return "Вибачте, технічна помилка. Зверніться до менеджера: +380933570808";
  }

  const messages = conversationMessages.map((msg) => {
    if (msg.role === "user" && msg.imageDataUrl) {
      const mediaType = msg.imageDataUrl.split(";")[0].split(":")[1] || "image/jpeg";
      const base64Data = msg.imageDataUrl.split(",")[1];
      return {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
          { type: "text", text: msg.content || "Клієнт надіслав зображення" },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: BOT_SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await res.json();

    if (data.error) {
      console.error("[Claude] API error:", JSON.stringify(data.error));
      console.error("[Claude] HTTP status:", res.status);
      console.error("[Claude] API key prefix:", ANTHROPIC_API_KEY?.substring(0, 12) + "...");
      return "Вибачте, технічна помилка. Спробуйте написати ще раз або зателефонуйте: +380933570808 😊";
    }

    const text = data.content?.[0]?.text || "";
    return text;
  } catch (err) {
    console.error("[Claude] Request failed:", err.message);
    return "Вибачте, технічна помилка. Спробуйте написати ще раз або зателефонуйте: +380933570808 😊";
  }
}

// ═══════════════════════════════════════════════════════════
//  PROCESS MESSAGE (conversation memory + AI)
// ═══════════════════════════════════════════════════════════

async function processMessage(senderId, texts, images) {
  let conv = conversations.get(senderId);
  const now = Date.now();

  if (!conv || now - conv.lastActivity > CONVERSATION_TTL) {
    conv = { messages: [], lastActivity: now };
  }
  conv.lastActivity = now;

  const combinedText = texts.join("\n");
  const imageDataUrl = images.length > 0 ? images[0] : null;

  const userMessage = {
    role: "user",
    content: combinedText || "[Клієнт надіслав зображення]",
    imageDataUrl: imageDataUrl || undefined,
  };
  conv.messages.push(userMessage);

  while (conv.messages.length > MAX_CONVERSATION_MESSAGES) {
    conv.messages.shift();
  }

  // Keep image data only for the latest user message to save memory
  const claudeMessages = conv.messages.map((m, i) => {
    if (m.role === "user" && m.imageDataUrl && i < conv.messages.length - 1) {
      return { role: m.role, content: m.content };
    }
    return m;
  });

  console.log(`[AI] Calling Claude for ${senderId} (${claudeMessages.length} messages)`);

  const response = await callClaude(claudeMessages);

  conv.messages.push({ role: "assistant", content: response });
  conversations.set(senderId, conv);

  // Notify Telegram about handoff requests
  if (/підключу колегу|зв'яжеться|передам менеджеру|адміністратор/i.test(response)) {
    sendTelegramNotification(
      `🔔 <b>Бот передає клієнта менеджеру!</b>\nКлієнт: ${senderId}\nОстаннє: ${combinedText.substring(0, 200)}\nВідповідь: ${response.substring(0, 200)}`
    );
  }

  // Notify about potential order
  if (/оформлю|доставк|оплат|місто доставки/i.test(response)) {
    sendTelegramNotification(
      `🛒 <b>Можливе замовлення!</b>\nКлієнт: ${senderId}\nОстаннє: ${combinedText.substring(0, 200)}`
    );
  }

  scheduleFollowup(senderId, response);

  return response;
}

// ═══════════════════════════════════════════════════════════
//  SEND INSTAGRAM MESSAGE
// ═══════════════════════════════════════════════════════════

async function sendInstagramMessage(recipientId, text) {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    console.error("[Instagram] No access token configured");
    return;
  }

  text = sanitizeBotResponse(text);

  // Anti-duplicate at SEND level
  const textKey = text.substring(0, 100);
  const lastSent = recentSentMessages.get(recipientId);
  if (lastSent && lastSent.text === textKey && Date.now() - lastSent.time < SEND_DEDUP_TTL) {
    console.log(`[Instagram] Duplicate send blocked for ${recipientId}`);
    return;
  }
  recentSentMessages.set(recipientId, { text: textKey, time: Date.now() });
  setTimeout(() => recentSentMessages.delete(recipientId), SEND_DEDUP_TTL);

  const MAX_LEN = 950;
  const chunks = [];

  if (text.length <= MAX_LEN) {
    chunks.push(text);
  } else {
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n\n", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf("\n", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = remaining.lastIndexOf(". ", MAX_LEN);
      if (splitAt < MAX_LEN * 0.3) splitAt = MAX_LEN;
      chunks.push(remaining.substring(0, splitAt + 1).trim());
      remaining = remaining.substring(splitAt + 1).trim();
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch(
        `https://graph.instagram.com/v26.0/me/messages?access_token=${INSTAGRAM_ACCESS_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: chunks[i] },
          }),
        }
      );

      const data = await res.json();
      if (data.error) {
        console.error(`[Instagram] Send error (chunk ${i + 1}/${chunks.length}):`, data.error);
      } else {
        console.log(`[Instagram] Message sent (chunk ${i + 1}/${chunks.length}) to ${recipientId}`);
        const sentMsgId = data.message_id;
        if (sentMsgId) {
          botSentMessageIds.add(sentMsgId);
          setTimeout(() => botSentMessageIds.delete(sentMsgId), 300000);
        }
        let sentList = botSentTexts.get(recipientId);
        if (!sentList) {
          sentList = [];
          botSentTexts.set(recipientId, sentList);
        }
        sentList.push({ text: chunks[i].trim().substring(0, 100), time: Date.now() });
        setTimeout(() => {
          const list = botSentTexts.get(recipientId);
          if (list) {
            const idx = list.findIndex((e) => e.text === chunks[i].trim().substring(0, 100));
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) botSentTexts.delete(recipientId);
          }
        }, 120000);
      }

      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error("[Instagram] Send failed:", err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTAGRAM OAuth (token exchange)
// ═══════════════════════════════════════════════════════════

app.get("/auth/instagram", (_req, res) => {
  const redirectUri = `${RAILWAY_URL}/auth/callback`;
  const scope =
    "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments";
  const url = `https://www.facebook.com/v26.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  console.log("[Auth] Redirecting to Facebook Login...");
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error("[Auth] Authorization denied:", error);
    return res.status(400).send("Авторизація скасована. Спробуйте ще раз.");
  }

  try {
    const redirectUri = `${RAILWAY_URL}/auth/callback`;

    const tokenRes = await fetch(
      `https://graph.facebook.com/v26.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error("[Auth] Token exchange error:", tokenData.error);
      return res.status(400).send(`Помилка: ${tokenData.error.message}`);
    }

    const userToken = tokenData.access_token;

    // Long-lived token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v26.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${userToken}`
    );
    const longData = await longRes.json();
    const longUserToken = longData.access_token || userToken;

    // Get Pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v26.0/me/accounts?access_token=${longUserToken}`
    );
    const pagesData = await pagesRes.json();

    const pagesList = (pagesData.data || [])
      .map((p) => `<li><b>${p.name}</b> (ID: ${p.id})<br><textarea style="width:100%;height:60px;font-size:11px">${p.access_token}</textarea></li>`)
      .join("");

    res.send(`
      <h1>Profit Gift Bot — Авторизація</h1>
      <p>Знайдено ${pagesData.data?.length || 0} сторінок:</p>
      <ul>${pagesList || "<li>Сторінок не знайдено</li>"}</ul>
      <hr>
      <p><b>Long-lived User Token:</b></p>
      <textarea style="width:100%;height:80px;font-size:11px">${longUserToken}</textarea>
      <p>Скопіюйте потрібний токен і встановіть як INSTAGRAM_ACCESS_TOKEN на Railway.</p>
    `);
  } catch (err) {
    console.error("[Auth] Fatal error:", err.message);
    res.status(500).send(`Серверна помилка: ${err.message}`);
  }
});

// ═══════════════════════════════════════════════════════════
//  WEBHOOK VERIFICATION (Meta challenge)
// ═══════════════════════════════════════════════════════════

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === INSTAGRAM_VERIFY_TOKEN) {
    console.log("[Webhook] Verified successfully!");
    return res.status(200).send(challenge);
  }

  console.warn("[Webhook] Verification failed — token mismatch");
  return res.status(403).json({ error: "Forbidden" });
});

// ═══════════════════════════════════════════════════════════
//  WEBHOOK MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════

app.post("/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");

  if (!ANTHROPIC_API_KEY || !INSTAGRAM_ACCESS_TOKEN) {
    console.warn("[Webhook] Skipping — missing ANTHROPIC_API_KEY or INSTAGRAM_ACCESS_TOKEN");
    return;
  }

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.read || event.delivery) continue;

      // ── Echo handling ──
      if (event.message?.is_echo) {
        if (Date.now() - SERVER_START_TIME < ECHO_GRACE_PERIOD) continue;

        const echoRecipient = event.recipient?.id;
        const echoText = (event.message?.text || "").trim().substring(0, 100);
        const echoMid = event.message?.mid;

        if (echoRecipient && (echoText || echoMid)) {
          let isBotEcho = false;
          if (echoMid && botSentMessageIds.has(echoMid)) {
            botSentMessageIds.delete(echoMid);
            isBotEcho = true;
          }

          if (!isBotEcho && echoText) {
            const sentList = botSentTexts.get(echoRecipient);
            const matchIdx = sentList
              ? sentList.findIndex((e) => echoText === e.text)
              : -1;
            if (matchIdx !== -1) {
              sentList.splice(matchIdx, 1);
              if (sentList.length === 0) botSentTexts.delete(echoRecipient);
              isBotEcho = true;
            }
          }

          if (isBotEcho) {
            console.log(`[Echo] Bot echo for ${echoRecipient}`);
          } else {
            if (echoText && echoText.toLowerCase().startsWith("/bot")) {
              humanTakeover.delete(echoRecipient);
              console.log(`[Takeover] Admin sent /bot — bot RESUMED for ${echoRecipient}`);
            } else {
              humanTakeover.set(echoRecipient, Date.now());
              cancelFollowup(echoRecipient);
              console.log(`[Takeover] Admin replied to ${echoRecipient}, bot paused for 2 hours`);
            }
          }
        }
        continue;
      }

      const senderId = event.sender?.id;
      if (!senderId) continue;

      // ── Message ID dedup ──
      const messageId = event.message?.mid;
      if (messageId) {
        if (processedMessageIds.has(messageId)) continue;
        processedMessageIds.add(messageId);
        setTimeout(() => processedMessageIds.delete(messageId), MESSAGE_ID_TTL);
      }

      if (event.recipient?.id) BOT_IDS.add(event.recipient.id);
      if (BOT_IDS.has(senderId)) continue;

      cancelFollowup(senderId);

      // ── Human takeover check ──
      const takeoverTime = humanTakeover.get(senderId);
      if (takeoverTime && Date.now() - takeoverTime < HUMAN_TAKEOVER_TTL) {
        console.log(`[Takeover] Bot paused for ${senderId} — admin handling`);
        continue;
      } else if (takeoverTime) {
        humanTakeover.delete(senderId);
      }

      let messageText;
      let imageDataUrl = null;

      // ── Share/mention detection ──
      const isStoryMention =
        event.message?.attachments?.some((a) =>
          ["share", "story_mention", "reel", "ig_reel", "media_share"].includes(a.type)
        ) || event.referral?.type === "STORY_MENTION";

      if (isStoryMention) {
        const lastShare = lastShareResponse.get(senderId);
        if (lastShare && Date.now() - lastShare < SHARE_RESPONSE_COOLDOWN) continue;
        lastShareResponse.set(senderId, Date.now());
        console.log(`[Webhook] Story mention/share from ${senderId} — no reply`);
        continue;
      }

      // ── Suppress text after story mention ──
      const recentShare = lastShareResponse.get(senderId);
      if (recentShare && Date.now() - recentShare < 10000) continue;

      // ── Emoji reactions — silent ──
      const rawText = event.message?.text || "";
      const isReaction = event.reaction != null;
      const hasOnlyDigitsOrPunctuation = /^[\d\s:.,#*+\-()]+$/.test(rawText.trim());
      const isPureEmoji =
        rawText.length > 0 &&
        rawText.length <= 8 &&
        !hasOnlyDigitsOrPunctuation &&
        /^[\p{Emoji}\p{Emoji_Component}‍️\s]+$/u.test(rawText);
      if (isReaction || isPureEmoji) {
        console.log(`[Webhook] Emoji from ${senderId}: "${rawText || event.reaction?.emoji}" — ignoring`);
        continue;
      }

      // ── Regular message handling ──
      if (!messageText) {
        if (event.message?.text) {
          messageText = event.message.text;
        } else if (event.message?.attachments) {
          const types = event.message.attachments.map((a) => a.type);

          const audioAttachment = event.message.attachments.find((a) => a.type === "audio");
          if (audioAttachment && audioAttachment.payload?.url) {
            console.log(`[Webhook] Voice from ${senderId}, transcribing...`);
            const transcription = await transcribeAudio(audioAttachment.payload.url);
            messageText = transcription || "[Клієнт надіслав голосове повідомлення, яке не вдалося розпізнати]";
          } else if (types.includes("image")) {
            const imgAttachment = event.message.attachments.find((a) => a.type === "image");
            if (imgAttachment?.payload?.url) {
              imageDataUrl = await downloadImageAsBase64(imgAttachment.payload.url);
            }
            messageText = event.message.text || "";
          } else {
            messageText = `[Клієнт надіслав: ${types.join(", ")}]`;
          }
        } else if (event.postback) {
          messageText = event.postback.payload || event.postback.title || "[кнопка]";
        } else {
          continue;
        }
      }

      console.log(`[Webhook] Message from ${senderId}: ${(messageText || "[image]").substring(0, 80)}`);

      // Telegram notification — only first message per client (2h cooldown)
      const lastNotify = lastTelegramNotify.get(senderId) || 0;
      if (Date.now() - lastNotify > TELEGRAM_NOTIFY_COOLDOWN) {
        lastTelegramNotify.set(senderId, Date.now());
        sendTelegramNotification(
          `💬 <b>Нове повідомлення в DM!</b>\nКлієнт: ${senderId}\n${(messageText || "[зображення]").substring(0, 300)}`
        );
      }

      // ── Message batching ──
      let queue = messageQueues.get(senderId);
      if (!queue) {
        queue = { messages: [], images: [], timer: null };
        messageQueues.set(senderId, queue);
      }

      if (messageText) queue.messages.push(messageText);
      if (imageDataUrl) queue.images.push(imageDataUrl);

      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = setTimeout(async () => {
        const texts = [...queue.messages];
        const images = [...queue.images];
        queue.messages = [];
        queue.images = [];
        messageQueues.delete(senderId);

        console.log(`[Bot] Processing ${texts.length} text(s) + ${images.length} image(s) from ${senderId}`);

        try {
          const response = await processMessage(senderId, texts, images);
          await sendInstagramMessage(senderId, response);
        } catch (err) {
          console.error("[Bot] Fatal error:", err.message);
          try {
            await sendInstagramMessage(
              senderId,
              "Вибачте, сталася технічна помилка 😊 Зверніться до менеджера: +380933570808"
            );
          } catch {}
        }
      }, MESSAGE_BATCH_DELAY);
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════

app.listen(PORT, async () => {
  console.log(`Profit Gift Bot running on port ${PORT}`);
  console.log(`  Webhook:    /webhook (GET verify, POST messages)`);
  console.log(`  Instagram:  ${INSTAGRAM_ACCESS_TOKEN ? "configured" : "NOT SET"}`);
  console.log(`  Claude:     ${ANTHROPIC_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`  Telegram:   ${TELEGRAM_BOT_TOKEN ? "configured" : "NOT SET"}`);
  await fetchBotId();
});
