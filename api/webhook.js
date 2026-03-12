import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Redis } from "@upstash/redis";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import jsQR from "jsqr";
import archiver from "archiver";
import { PassThrough } from "stream";

// --- CONFIGURATION ---
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349;
const CHANNEL = "@StorylineArtNetwork";
const GOTENBERG_URL = "https://storyline-studio-engine.onrender.com";
const REMBG_URL = "https://storylineart3-rembg-api.hf.space/api/remove";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Online");
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) { console.error("Error:", err.message); }
  return res.status(200).send("ok");
}

/* ────────────── MESSAGE HANDLER ────────────── */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  await redis.sadd("users", chatId);
  
  if (!(await checkJoin(chatId))) {
    return sendMessage(chatId, `⛔ *Access Restricted*\n\nPlease join ${CHANNEL} to unlock unlimited tools.`);
  }

  // ADMIN PANEL
  if (chatId === ADMIN_ID) {
    if (text === "/stats") {
      const total = await redis.scard("users");
      const stats = await redis.hgetall("feature_stats") || {};
      let statMsg = `📊 *BOT ANALYTICS*\n\n👥 *Total Users:* ${total}\n\n🔥 *Feature Usage:*`;
      for (const [feat, count] of Object.entries(stats)) {
        statMsg += `\n- ${feat}: ${count}`;
      }
      return sendMessage(chatId, statMsg);
    }
  }

  // START & WAKE-UP ENGINE
  if (text === "/start" || text === "/menu") {
    // Silent background pings to keep engines hot
    axios.get(GOTENBERG_URL).catch(() => {});
    axios.get(REMBG_URL.replace("/api/remove", "")).catch(() => {});

    return sendButtons(chatId, "💠 *FILE & IMAGE STUDIO*\n\nWelcome to File Converter & Resizer Bot, send PDF, WORD, DOCX or Images to use tools. Send any Image or Document to begin.", [
      [{ text: "🔳 Generate QR", callback_data: "qr_gen" }, { text: "📦 View Batch", callback_data: "m_batch" }],
      [{ text: "❓ Help & Guide", callback_data: "help" }]
    ]);
  }

  // QR STATE
  if ((await redis.get(`state:${chatId}`)) === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "qr.png");
  }

  // FILE DETECTION
  let fileId, menuTitle, buttons;
  if (msg.photo) {
    fileId = msg.photo.pop().file_id;
    menuTitle = "🖼 *IMAGE TOOLS*";
    buttons = [
      [{text:"🔄 Convert To...",callback_data:"menu_fmt"}, {text:"📐 Resize/Ratio",callback_data:"menu_res"}],
      [{text:"🗜 Compress",callback_data:"menu_cmp"}, {text:"✨ Remove BG (Free)",callback_data:"remove_bg"}],
      [{text:"🔍 Read QR",callback_data:"qr_scan"}, {text:"➕ Add to ZIP",callback_data:"b_add"}]
    ];
  } else if (msg.document) {
    fileId = msg.document.file_id;
    const n = msg.document.file_name.toLowerCase();
    if (n.endsWith(".pdf")) {
      menuTitle = "📄 *PDF DETECTED*";
      buttons = [[{text:"PDF ➝ JPG",callback_data:"pdf_jpg"}, {text:"PDF ➝ DOCX",callback_data:"pdf_docx"}]];
    } else if (n.endsWith(".docx") || n.endsWith(".doc") || n.endsWith(".epub")) {
      menuTitle = "📝 *DOC DETECTED*";
      buttons = [[{text:"Convert to PDF",callback_data:"doc_pdf"}]];
    }
  }

  if (fileId) {
    await redis.set(`file:${chatId}`, fileId, { ex: 3600 });
    return sendButtons(chatId, menuTitle, buttons);
  }
}

/* ────────────── CALLBACK HANDLER ────────────── */
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;
  
  await axios.post(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, { callback_query_id: query.id });
  
  if (action === "help") return sendHelp(chatId);
  if (action === "menu_fmt") return sendButtons(chatId, "🔄 *Convert to:*", [[{text:"PNG",callback_data:"fmt_png"}, {text:"JPG",callback_data:"fmt_jpg"}], [{text:"WEBP",callback_data:"fmt_webp"}, {text:"Sticker",callback_data:"fmt_sticker"}]]);
  if (action === "menu_res") return sendButtons(chatId, "📐 *Aspect Ratio:*", [[{text:"2:3 (Cover)",callback_data:"res_2:3"}, {text:"16:9",callback_data:"res_16:9"}], [{text:"1:1",callback_data:"res_1:1"}]]);
  if (action === "m_batch") return sendButtons(chatId, "📦 *Batch Queue:*", [[{text:"⬇️ ZIP",callback_data:"b_zip"},{text:"🗑 Clear",callback_data:"b_clr"}]]);
  if (action === "qr_gen") { await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 }); return sendMessage(chatId, "⌨️ Send text/link for QR:"); }
  if (action === "b_clr") { await redis.del(`batch:${chatId}`); return sendMessage(chatId, "🗑 Cleared."); }

  await processTask(chatId, action, query.message.message_id);
}

/* ────────────── TASK PROCESSOR ────────────── */
async function processTask(chatId, action, msgId) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return;

  // 1. Show Processing Message
  const proc = await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: chatId, 
    text: "⏳ *Processing your request...*\n_This may take a moment for larger files._",
    parse_mode: "Markdown"
  });

  try {
    const url = await getUrl(fileId);
    
    // TRACK FEATURE USAGE
    const featName = action.includes("_") ? action.split("_")[0] : action;
    await redis.hincrby("feature_stats", featName, 1);

    // 2. LOGIC
    if (action === "remove_bg") {
      const res = await axios.get(`${REMBG_URL}?url=${encodeURIComponent(url)}`, { responseType: 'arraybuffer' });
      await sendFile(chatId, Buffer.from(res.data), "Result_NoBG.png");
    }

    else if (["doc_pdf", "pdf_jpg", "pdf_docx"].includes(action)) {
      const form = new FormData();
      const file = await axios.get(url, { responseType: 'stream' });
      form.append('files', file.data, { filename: "input.docx" });
      const res = await axios.post(`${GOTENBERG_URL}/forms/libreoffice/convert`, form, { headers: form.getHeaders(), responseType: 'arraybuffer' });
      await sendFile(chatId, Buffer.from(res.data), `Studio_Output.${action.split('_')[1]}`);
    }

    else if (action.startsWith("fmt_") || action.startsWith("res_")) {
      const imgData = await axios.get(url, { responseType: 'arraybuffer' });
      let buf;
      if (action.startsWith("fmt_")) {
        const f = action.split("_")[1];
        buf = await sharp(imgData.data)[f === "sticker" ? "webp" : f]().toBuffer();
        await sendFile(chatId, buf, `Converted.${f}`);
      } else {
        const r = action.split("_")[1];
        buf = await sharp(imgData.data).resize(r === "16:9" ? 1280 : 800, null).toBuffer();
        await sendFile(chatId, buf, "Resized.jpg");
      }
    }

    // 3. Delete Processing Message when finished
    await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteMessage`, { chat_id: chatId, message_id: proc.data.result.message_id });

  } catch (e) {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
      chat_id: chatId,
      message_id: proc.data.result.message_id,
      text: "⚠️ *Engine is still waking up.*\n\nPlease wait 30 seconds and try that button again!",
      parse_mode: "Markdown"
    });
  }
}

/* ────────────── HELPERS ────────────── */
async function getUrl(id) {
  const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${id}`);
  return `https://api.telegram.org/file/bot${TOKEN}/${r.data.result.file_path}`;
}
async function sendFile(chatId, buffer, filename) {
  const f = new FormData(); f.append("chat_id", chatId); f.append("document", buffer, { filename });
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`, f, { headers: f.getHeaders() });
}
async function checkJoin(id) {
  try { const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${id}`);
  return ["member", "administrator", "creator"].includes(r.data.result.status); } catch (e) { return true; }
}
async function sendMessage(id, text) { return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown" }); }
async function sendButtons(id, text, buttons) { return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }); }
async function sendHelp(id) { return sendMessage(id, "📖 *GUIDE*\n1. Send an image for background removal or conversion.\n2. Send a Word or PDF file to convert.\n3. Everything is unlimited and free!"); }

