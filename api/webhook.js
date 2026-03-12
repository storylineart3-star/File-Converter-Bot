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
    return sendMessage(chatId, `⛔ *Access Restricted*\n\nPlease join ${CHANNEL} to unlock all features.`);
  }

  // ADMIN STATS BREAKDOWN
  if (chatId === ADMIN_ID && text === "/stats") {
    const total = await redis.scard("users");
    const stats = await redis.hgetall("feature_stats") || {};
    let statMsg = `📊 *STUDIO ANALYTICS*\n\n👥 *Total Users:* ${total}\n\n🔥 *Top Features:*`;
    for (const [feat, count] of Object.entries(stats)) {
      statMsg += `\n- ${feat.toUpperCase()}: ${count}`;
    }
    return sendMessage(chatId, statMsg);
  }

  // CLEAN WELCOME MESSAGE
  if (text === "/start" || text === "/menu") {
    axios.get(GOTENBERG_URL).catch(() => {});
    axios.get(REMBG_URL.replace("/api/remove", "")).catch(() => {});

    const welcome = "👋 *Welcome to Storyline Art Studio!*\n\nI am your all-in-one file assistant. Send me any file to begin:\n\n" +
      "🖼 *Images:* Remove BG, Resize, Convert, or Compress.\n" +
      "📄 *Documents:* Convert Word/EPUB to PDF or PDF to JPG.\n" +
      "🔳 *QR Tools:* Create or Scan QR codes instantly.\n" +
      "📦 *Batch:* Add multiple images and download as a ZIP.";

    return sendButtons(chatId, welcome, [
      [{ text: "🔳 Generate QR", callback_data: "qr_gen" }, { text: "📦 My Batch", callback_data: "m_batch" }],
      [{ text: "❓ How to use?", callback_data: "help" }]
    ]);
  }

  // QR STATE
  if ((await redis.get(`state:${chatId}`)) === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "generated_qr.png");
  }

  // FILE DETECTION
  let fileId, menuTitle, buttons;
  if (msg.photo) {
    fileId = msg.photo.pop().file_id;
    menuTitle = "🖼 *IMAGE OPTIONS*";
    buttons = [
      [{text:"🔄 Convert",callback_data:"menu_fmt"}, {text:"📐 Aspect Ratio",callback_data:"menu_res"}],
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
      menuTitle = "📝 *DOCUMENT DETECTED*";
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

  if (action === "menu_fmt") return sendButtons(chatId, "🔄 *Convert to:*", [[{text:"PNG",callback_data:"fmt_png"}, {text:"JPG",callback_data:"fmt_jpg"}], [{text:"WEBP (File)",callback_data:"fmt_webp"}, {text:"Sticker",callback_data:"fmt_sticker"}]]);
  if (action === "menu_res") return sendButtons(chatId, "📐 *Aspect Ratio:*", [[{text:"2:3 (Cover)",callback_data:"res_2:3"}, {text:"16:9",callback_data:"res_16:9"}], [{text:"1:1 (Square)",callback_data:"res_1:1"}]]);
  if (action === "menu_cmp") return sendButtons(chatId, "🗜 *Compression:*", [[{text:"High",callback_data:"cmp_80"}, {text:"Low",callback_data:"cmp_20"}]]);
  if (action === "m_batch") return sendButtons(chatId, "📦 *Batch Queue:*", [[{text:"⬇️ Download ZIP",callback_data:"b_zip"},{text:"🗑 Clear",callback_data:"b_clr"}]]);
  if (action === "qr_gen") { await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 }); return sendMessage(chatId, "⌨️ Send text/link:"); }
  if (action === "b_clr") { await redis.del(`batch:${chatId}`); return sendMessage(chatId, "🗑 Queue cleared."); }
  if (action === "help") return sendHelp(chatId);

  await processTask(chatId, action);
}

/* ────────────── TASK PROCESSOR ────────────── */
async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return;

  const proc = await sendMessage(chatId, "⏳ *Processing... Please wait.*");

  try {
    const url = await getUrl(fileId);
    await redis.hincrby("feature_stats", action.split("_")[0], 1);

    // 1. FIXED BACKGROUND REMOVAL (Pushing buffer to bypass DNS errors)
    if (action === "remove_bg") {
      const imgBuffer = await axios.get(url, { responseType: 'arraybuffer' });
      const form = new FormData();
      form.append('file', imgBuffer.data, { filename: 'image.png' });
      
      const res = await axios.post(REMBG_URL, form, { 
        headers: form.getHeaders(), 
        responseType: 'arraybuffer' 
      });
      await sendFile(chatId, Buffer.from(res.data), "No_BG.png");
    }

    // 2. PDF / DOC CONVERSION
    else if (["doc_pdf", "pdf_jpg", "pdf_docx"].includes(action)) {
      const form = new FormData();
      const file = await axios.get(url, { responseType: 'stream' });
      form.append('files', file.data, { filename: action.includes("pdf") ? "in.pdf" : "in.docx" });
      const res = await axios.post(`${GOTENBERG_URL}/forms/libreoffice/convert`, form, { headers: form.getHeaders(), responseType: 'arraybuffer' });
      await sendFile(chatId, Buffer.from(res.data), `Result.${action.split('_')[1]}`);
    }

    // 3. IMAGE TOOLS (SHARP) + FIX STICKER/WEBP
    else if (action.startsWith("fmt_") || action.startsWith("res_") || action.startsWith("cmp_")) {
      const img = await axios.get(url, { responseType: 'arraybuffer' });
      
      if (action === "fmt_sticker") {
        const sBuf = await sharp(img.data).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();
        await sendSticker(chatId, sBuf);
      } 
      else if (action === "fmt_webp") {
        const wBuf = await sharp(img.data).webp().toBuffer();
        await sendFile(chatId, wBuf, "image.webp");
      }
      else {
        let pipeline = sharp(img.data);
        if (action.startsWith("res_")) {
          const r = action.split("_")[1];
          pipeline = pipeline.resize(r === "16:9" ? 1280 : 800, null);
        }
        if (action.startsWith("cmp_")) {
          pipeline = pipeline.jpeg({ quality: parseInt(action.split("_")[1]) });
        }
        const finalBuf = await pipeline.toBuffer();
        await sendFile(chatId, finalBuf, "processed.jpg");
      }
    }

    // 4. BATCH ZIP
    if (action === "b_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const r = await axios.get(await getUrl(id), { responseType: 'arraybuffer' });
        archive.append(r.data, { name: `file_${i+1}.jpg` });
      }
      archive.finalize();
      await sendFile(chatId, stream, "Studio_Batch.zip");
    }

    // Cleanup
    await axios.post(`https://api.telegram.org/bot${TOKEN}/deleteMessage`, { chat_id: chatId, message_id: proc.data.result.message_id });

  } catch (e) {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
      chat_id: chatId, message_id: proc.data.result.message_id,
      text: "⚠️ *Server is booting up.* Please try again in 30 seconds."
    });
  }
}

/* ────────────── UTILS ────────────── */
async function getUrl(id) {
  const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${id}`);
  return `https://api.telegram.org/file/bot${TOKEN}/${r.data.result.file_path}`;
}
async function sendFile(chatId, buffer, filename) {
  const f = new FormData(); f.append("chat_id", chatId); f.append("document", buffer, { filename });
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`, f, { headers: f.getHeaders() });
}
async function sendSticker(chatId, buffer) {
  const f = new FormData(); f.append("chat_id", chatId); f.append("sticker", buffer, { filename: "sticker.webp" });
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendSticker`, f, { headers: f.getHeaders() });
}
async function checkJoin(id) {
  try { const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${id}`);
  return ["member", "administrator", "creator"].includes(r.data.result.status); } catch (e) { return true; }
}
async function sendMessage(id, text) { return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown" }); }
async function sendButtons(id, text, buttons) { return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }); }
async function sendHelp(id) { return sendMessage(id, "📖 *QUICK GUIDE*\n\n1. Send an image to get format and background tools.\n2. Send a PDF or Word file to convert them.\n3. Add images to 'Batch' to get a single ZIP file."); }

