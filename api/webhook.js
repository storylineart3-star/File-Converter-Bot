import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Redis } from "@upstash/redis";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import jsQR from "jsqr";
import archiver from "archiver";
import ConvertAPI from 'convertapi';
import { PassThrough } from "stream";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349;
const CHANNEL = "@StorylineArtNetwork";
const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET || '');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("⚡ Bot Active");
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
  if (!(await checkJoin(chatId))) return sendMessage(chatId, `⛔ Please join ${CHANNEL} to access the bot.`);

  if (text === "/start" || text === "/menu") {
    return sendButtons(chatId, "⌬ *SYSTEM ONLINE*\n\nSend any Image, PDF, or Document to begin processing.", [
      [{ text: "🔲 Generate QR", callback_data: "qr_gen" }, { text: "📦 My Batch ZIP", callback_data: "m_batch" }]
    ]);
  }

  if ((await redis.get(`state:${chatId}`)) === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "qrcode.png");
  }

  let fileId, type, menuTitle, buttons;

  if (msg.photo) {
    fileId = msg.photo.pop().file_id;
    type = "img";
    menuTitle = "🎴 *IMAGE DETECTED*\nSelect a processing module:";
    buttons = [
      [{text:"🔄 Format",callback_data:"menu_fmt"}, {text:"📐 Resize",callback_data:"menu_res"}],
      [{text:"🗜 Compress",callback_data:"menu_cmp"}, {text:"✨ Auto-Cut (Admin)",callback_data:"remove_bg"}],
      [{text:"🔍 Read QR",callback_data:"qr_scan"}, {text:"➕ Queue to ZIP",callback_data:"b_add"}]
    ];
  } 
  else if (msg.document) {
    fileId = msg.document.file_id;
    const fileName = msg.document.file_name.toLowerCase();
    
    if (fileName.endsWith(".pdf")) {
      menuTitle = "📄 *PDF DETECTED*";
      buttons = [[{text:"PDF ➝ JPG",callback_data:"pdf_jpg"}, {text:"PDF ➝ DOCX",callback_data:"pdf_docx"}]];
    } else if (fileName.endsWith(".docx") || fileName.endsWith(".doc")) {
      menuTitle = "📝 *WORD DOC DETECTED*";
      buttons = [[{text:"DOCX ➝ PDF",callback_data:"docx_pdf"}, {text:"DOCX ➝ TXT",callback_data:"docx_txt"}]];
    } else if (fileName.endsWith(".epub")) {
      menuTitle = "📚 *EPUB DETECTED*";
      buttons = [[{text:"EPUB ➝ PDF",callback_data:"epub_pdf"}, {text:"EPUB ➝ TXT",callback_data:"epub_txt"}]];
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
  const queryId = query.id;

  // STOP THE GLOWING BUTTON
  await axios.post(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, { callback_query_id: queryId });

  // Sub-Menus
  if (action === "menu_fmt") return sendButtons(chatId, "🔄 *Select Output Format:*", [[{text:"PNG",callback_data:"fmt_png"}, {text:"JPG",callback_data:"fmt_jpg"}, {text:"WEBP",callback_data:"fmt_webp"}], [{text:"Sticker",callback_data:"fmt_sticker"}, {text:"PDF",callback_data:"fmt_pdf"}]]);
  if (action === "menu_res") return sendButtons(chatId, "📐 *Select Aspect Ratio:*", [[{text:"2:3 (Cover)",callback_data:"res_2:3"}, {text:"16:9 (Cinematic)",callback_data:"res_16:9"}], [{text:"1:1 (Square)",callback_data:"res_1:1"}, {text:"4:3 (Standard)",callback_data:"res_4:3"}]]);
  if (action === "menu_cmp") return sendButtons(chatId, "🗜 *Select Compression Level:*", [[{text:"High Qlty (Large)",callback_data:"cmp_80"}], [{text:"Medium Qlty",callback_data:"cmp_50"}], [{text:"Low Qlty (Small)",callback_data:"cmp_20"}]]);
  
  if (action === "m_batch") return sendButtons(chatId, "📦 *Batch Options:*", [[{text:"⬇️ Download ZIP",callback_data:"b_zip"},{text:"🗑 Clear",callback_data:"b_clr"}]]);
  if (action === "qr_gen") {
    await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 });
    return sendMessage(chatId, "⌨️ Awaiting text or URL for QR generation...");
  }
  if (action === "remove_bg" && chatId !== ADMIN_ID) return sendMessage(chatId, "⛔ Access Denied. Admin privileges required.");
  if (action === "b_clr") {
    await redis.del(`batch:${chatId}`);
    return sendMessage(chatId, "🗑 Batch queue cleared.");
  }

  await processTask(chatId, action);
}

/* ────────────── TASK PROCESSOR ────────────── */
async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return sendMessage(chatId, "⚠️ File expired or missing. Please upload again.");

  try {
    const url = await getUrl(fileId);

    // Limit Tracker for ConvertAPI & RemoveBG
    if (action.includes("_") && !action.startsWith("fmt_") && !action.startsWith("res_") && !action.startsWith("cmp_")) {
      const dayKey = `limit:${new Date().toISOString().split('T')[0]}`;
      const used = await redis.incr(dayKey);
      await redis.expire(dayKey, 86400);
      if (used > 25 && chatId !== ADMIN_ID) return sendMessage(chatId, "⚠️ Daily API quota exhausted.");
    }

    if (action === "qr_scan") {
      const img = await axios.get(url, { responseType: 'arraybuffer' });
      const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return sendMessage(chatId, code ? `✅ **DECODED DATA:**\n\n\`${code.data}\`` : "❌ No legible QR detected.");
    }

    if (action === "b_add") {
      const len = await redis.llen(`batch:${chatId}`);
      if (len >= 10) return sendMessage(chatId, "⛔ Queue limit reached (10/10).");
      await redis.rpush(`batch:${chatId}`, fileId);
      return sendMessage(chatId, `✅ Added to Queue (${len + 1}/10).`);
    }

    if (action === "b_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      if (!ids.length) return sendMessage(chatId, "⚠️ Queue is empty.");
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const u = await getUrl(id);
        const r = await axios.get(u, { responseType: 'arraybuffer' });
        archive.append(r.data, { name: `export_${i+1}.jpg` });
      }
      archive.finalize();
      return sendFile(chatId, stream, "Batch_Export.zip");
    }

    if (action === "remove_bg") {
      const res = await axios.post("https://api.remove.bg/v1.0/removebg", { image_url: url, size: "auto" }, { headers: { "X-API-Key": process.env.REMOVE_BG_KEY }, responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(res.data), "Transparent_Cutout.png");
    }

    // ConvertAPI (Documents)
    if (action.includes("_") && !action.startsWith("fmt_") && !action.startsWith("res_") && !action.startsWith("cmp_")) {
      const [from, to] = action.split("_");
      const res = await convertapi.convert(to, { File: url }, from);
      const data = await axios.get(res.file.url, { responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(data.data), `Document.${to}`);
    }

    /* --- SHARP IMAGE PROCESSING --- */
    const img = await axios.get(url, { responseType: 'arraybuffer' });
    let buf;
    
    // Formatting
    if (action.startsWith("fmt_")) {
      const fmt = action.split("_")[1];
      if (fmt === "sticker") buf = await sharp(img.data).resize(512,512).webp().toBuffer();
      else if (fmt === "pdf") {
        const pdfDoc = await PDFDocument.create();
        const imgP = await pdfDoc.embedJpg(img.data);
        const page = pdfDoc.addPage([imgP.width, imgP.height]);
        page.drawImage(imgP, { x: 0, y: 0, width: imgP.width, height: imgP.height });
        buf = Buffer.from(await pdfDoc.save());
      } else {
        buf = await sharp(img.data)[fmt]().toBuffer();
      }
      return sendFile(chatId, buf, `Export.${fmt === "sticker" ? "webp" : fmt}`);
    }

    // Resizing
    if (action.startsWith("res_")) {
      const ratio = action.split("_")[1];
      const metadata = await sharp(img.data).metadata();
      let w = metadata.width;
      let h = metadata.height;

      if (ratio === "2:3") { w / h > 2/3 ? w = Math.round(h * (2/3)) : h = Math.round(w * (3/2)); }
      else if (ratio === "16:9") { w / h > 16/9 ? w = Math.round(h * (16/9)) : h = Math.round(w * (9/16)); }
      else if (ratio === "1:1") { w = Math.min(w, h); h = w; }
      else if (ratio === "4:3") { w / h > 4/3 ? w = Math.round(h * (4/3)) : h = Math.round(w * (3/4)); }

      buf = await sharp(img.data).resize(w, h, { fit: 'cover' }).jpeg().toBuffer();
      return sendFile(chatId, buf, `Resized_${ratio.replace(':', 'x')}.jpg`);
    }

    // Compression
    if (action.startsWith("cmp_")) {
      const quality = parseInt(action.split("_")[1]);
      buf = await sharp(img.data).jpeg({ quality: quality }).toBuffer();
      return sendFile(chatId, buf, `Compressed.jpg`);
    }

  } catch (e) { sendMessage(chatId, "⚠️ Task Failed: File may be corrupted or too large."); }
}

/* ────────────── UTILITIES ────────────── */
async function getUrl(id) {
  const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${id}`);
  return `https://api.telegram.org/file/bot${TOKEN}/${res.data.result.file_path}`;
}

async function sendFile(chatId, buffer, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", buffer, { filename });
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`, form, { headers: form.getHeaders() });
}

async function checkJoin(id) {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${id}`);
    return ["member", "administrator", "creator"].includes(r.data.result.status);
  } catch (e) { return true; }
}

async function sendMessage(id, text) {
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown" });
}

async function sendButtons(id, text, buttons) {
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } });
}

