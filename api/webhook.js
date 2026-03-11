import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Redis } from "@upstash/redis";
import { PDFDocument } from "pdf-lib";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349;
const CHANNEL = "@StorylineArtNetwork"; // Ensure bot is admin here

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Bot running");

  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("Global Error:", err.message);
  }
  return res.status(200).send("ok");
}

/* ---------- MESSAGE HANDLER ---------- */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  // 1. Rate Limiting (5 requests per minute)
  const rateLimit = await redis.get(`limit:${chatId}`);
  if (rateLimit > 5) return sendMessage(chatId, "⚠️ Too many requests. Wait a minute.");
  await redis.incr(`limit:${chatId}`);
  await redis.expire(`limit:${chatId}`, 60);

  // 2. Register User & Force Join Check
  await redis.sadd("users", chatId);
  const isJoined = await checkJoin(chatId);
  if (!isJoined) {
    return sendMessage(chatId, `❌ Please join ${CHANNEL} to use this bot.`);
  }

  // 3. Admin Commands
  if (chatId === ADMIN_ID) {
    if (text === "/stats") {
      const count = await redis.scard("users");
      return sendMessage(chatId, `📊 Total Users: ${count}`);
    }
    if (text?.startsWith("/broadcast")) {
      const broadcastMsg = text.replace("/broadcast ", "");
      const users = await redis.smembers("users");
      for (const id of users) {
        try { await sendMessage(id, broadcastMsg); } catch (e) {}
      }
      return sendMessage(chatId, "✅ Broadcast sent.");
    }
  }

  if (text === "/start" || text === "/menu") {
    return sendMenu(chatId);
  }

  if (msg.photo) {
    const fileId = msg.photo.pop().file_id;
    await redis.set(`file:${chatId}`, fileId, { ex: 3600 }); // Store for 1 hour
    return sendMessage(chatId, "📸 Image saved! Now open the /menu to choose an action.");
  }
}

/* ---------- CALLBACK HANDLER ---------- */
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  // Navigation Logic
  const menus = {
    convert: [
      [{ text: "PNG", callback_data: "png" }],
      [{ text: "JPG", callback_data: "jpg" }],
      [{ text: "WEBP", callback_data: "webp" }]
    ],
    resize: [
      [{ text: "512x512", callback_data: "512" }],
      [{ text: "1024x1024", callback_data: "1024" }],
      [{ text: "2:3 Poster", callback_data: "poster" }]
    ],
    compress: [
      [{ text: "High", callback_data: "c40" }],
      [{ text: "Medium", callback_data: "c60" }],
      [{ text: "Low", callback_data: "c80" }]
    ]
  };

  if (menus[action]) {
    return sendButtons(chatId, `Select ${action} option:`, menus[action]);
  }

  await processImage(chatId, action);
}

/* ---------- IMAGE PROCESS ---------- */
async function processImage(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId) return sendMessage(chatId, "❌ Please send an image first.");

  await sendMessage(chatId, "⏳ Processing...");

  const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.data.result.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const input = response.data;

  let buffer;
  let filename = `result_${Date.now()}`;
  let type = "document";

  try {
    // Logic Switch
    if (["png", "jpg", "webp"].includes(action)) {
      buffer = await sharp(input)[action === "jpg" ? "jpeg" : action]().toBuffer();
      filename += `.${action}`;
    } else if (action === "512") {
      buffer = await sharp(input).resize(512, 512).toBuffer();
      filename += ".jpg";
    } else if (action === "1024") {
      buffer = await sharp(input).resize(1024, 1024).toBuffer();
      filename += ".jpg";
    } else if (action === "poster") {
      buffer = await sharp(input).resize(1200, 1800).toBuffer();
      filename += ".jpg";
    } else if (action.startsWith("c")) {
      const q = parseInt(action.replace("c", ""));
      buffer = await sharp(input).jpeg({ quality: q }).toBuffer();
      filename += ".jpg";
    } else if (action === "sticker") {
      buffer = await sharp(input).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();
      type = "sticker";
    } else if (action === "pdf") {
      const pdfDoc = await PDFDocument.create();
      const imgBytes = await sharp(input).png().toBuffer();
      const img = await pdfDoc.embedPng(imgBytes);
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      buffer = Buffer.from(await pdfDoc.save());
      filename += ".pdf";
    } else if (action === "meta") {
      buffer = await sharp(input).withMetadata(false).toBuffer();
      filename += ".jpg";
    }

    // Send logic
    const form = new FormData();
    form.append("chat_id", chatId);

    if (type === "sticker") {
      form.append("sticker", buffer, { filename: "sticker.webp" });
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendSticker`, form, { headers: form.getHeaders() });
    } else {
      form.append("document", buffer, { filename });
      form.append("disable_content_type_detection", "true"); // Fixes WEBP sticker issue
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`, form, { headers: form.getHeaders() });
    }
  } catch (e) {
    sendMessage(chatId, "❌ Processing failed.");
  }
}

/* ---------- HELPERS ---------- */
async function checkJoin(userId) {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${userId}`);
    const status = res.data.result.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch (e) { return true; } // Fallback if check fails
}

async function sendMenu(chatId) {
  return sendButtons(chatId, "🛠 *Main Menu*\nChoose an action below:", [
    [{ text: "🔄 Convert", callback_data: "convert" }, { text: "📐 Resize", callback_data: "resize" }],
    [{ text: "📉 Compress", callback_data: "compress" }, { text: "🎭 Sticker", callback_data: "sticker" }],
    [{ text: "📄 PDF", callback_data: "pdf" }, { text: "🛡 Remove Meta", callback_data: "meta" }]
  ]);
}

async function sendMessage(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: chatId, text, parse_mode: "Markdown" });
}

async function sendButtons(chatId, text, buttons) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}
