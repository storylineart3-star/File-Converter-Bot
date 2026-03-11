import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Redis } from "@upstash/redis";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import jsQR from "jsqr";
import archiver from "archiver";
import { PassThrough } from "stream";

// CONFIGURATION
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349;
const CHANNEL = "@StorylineArtNetwork";
const GOTENBERG_URL = "https://storyline-studio-engine.onrender.com";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* ────────────── MAIN HANDLER ────────────── */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("System: Online");
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) { console.error("Runtime Error:", err.message); }
  return res.status(200).send("ok");
}

/* ────────────── MESSAGE HANDLER ────────────── */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  // USER TRACKING
  await redis.sadd("users", chatId);
  
  // MEMBERSHIP CHECK
  if (!(await checkJoin(chatId))) {
    return sendMessage(chatId, `⛔ *Access Restricted*\n\nPlease join ${CHANNEL} to unlock all features.`);
  }

  // ADMIN COMMANDS (Stats & Broadcast)
  if (chatId === ADMIN_ID) {
    if (text === "/stats") {
      const totalUsers = await redis.scard("users");
      return sendMessage(chatId, `📊 *BOT STATISTICS*\n\n👥 Total Users: ${totalUsers}\n⚙️ Engine: Gotenberg (Render)`);
    }
    
    if (text?.startsWith("/broadcast ")) {
      const broadcastMsg = text.replace("/broadcast ", "");
      const users = await redis.smembers("users");
      let successCount = 0;
      for (const id of users) {
        try { 
          await sendMessage(id, `📢 *NOTIFICATION*\n\n${broadcastMsg}`); 
          successCount++;
        } catch(e) { /* user blocked bot */ }
      }
      return sendMessage(chatId, `✅ Broadcast complete. Sent to ${successCount} users.`);
    }
  }

  // START & MENU (Includes Render Wake-up)
  if (text === "/start" || text === "/menu") {
    axios.get(GOTENBERG_URL).catch(() => {}); // Background Wake-up Ping
    
    return sendButtons(chatId, "💠 *FILE & IMAGE STUDIO*\n\nSend an Image, PDF, or Document to start. I've warmed up the engine for you!", [
      [{ text: "🔳 Generate QR", callback_data: "qr_gen" }, { text: "📦 View Batch", callback_data: "m_batch" }],
      [{ text: "❓ Help & Guide", callback_data: "help" }]
    ]);
  }

  if (text === "/help") return sendHelp(chatId);

  // QR GENERATOR STATE
  if ((await redis.get(`state:${chatId}`)) === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "generated_qr.png");
  }

  // FILE DETECTION LOGIC
  let fileId, menuTitle, buttons;

  if (msg.photo) {
    fileId = msg.photo.pop().file_id;
    menuTitle = "🖼 *IMAGE TOOLS*";
    buttons = [
      [{text:"🔄 Convert To...",callback_data:"menu_fmt"}, {text:"📐 Resize/Ratio",callback_data:"menu_res"}],
      [{text:"🗜 Compress",callback_data:"menu_cmp"}, {text:"✨ Remove BG",callback_data:"remove_bg"}],
      [{text:"🔍 Read QR",callback_data:"qr_scan"}, {text:"➕ Add to ZIP",callback_data:"b_add"}]
    ];
  } 
  else if (msg.document) {
    fileId = msg.document.file_id;
    const name = msg.document.file_name.toLowerCase();
    
    if (name.endsWith(".pdf")) {
      menuTitle = "📄 *PDF DETECTED*";
      buttons = [[{text:"PDF ➝ JPG",callback_data:"pdf_jpg"}, {text:"PDF ➝ DOCX",callback_data:"pdf_docx"}]];
    } else if (name.endsWith(".docx") || name.endsWith(".doc")) {
      menuTitle = "📝 *WORD DETECTED*";
      buttons = [[{text:"DOCX ➝ PDF",callback_data:"doc_pdf"}]];
    } else if (name.endsWith(".epub")) {
      menuTitle = "📚 *EPUB DETECTED*";
      buttons = [[{text:"EPUB ➝ PDF",callback_data:"epub_pdf"}]];
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
  if (action === "menu_fmt") return sendButtons(chatId, "🔄 *Convert to:*", [[{text:"PNG",callback_data:"fmt_png"}, {text:"JPG",callback_data:"fmt_jpg"}, {text:"WEBP (File)",callback_data:"fmt_webp"}], [{text:"Sticker",callback_data:"fmt_sticker"}, {text:"PDF",callback_data:"fmt_pdf"}]]);
  if (action === "menu_res") return sendButtons(chatId, "📐 *Aspect Ratio:*", [[{text:"2:3 (Cover)",callback_data:"res_2:3"}, {text:"16:9 (Cinematic)",callback_data:"res_16:9"}], [{text:"1:1 (Square)",callback_data:"res_1:1"}, {text:"4:3 (Standard)",callback_data:"res_4:3"}]]);
  if (action === "menu_cmp") return sendButtons(chatId, "🗜 *Compression:*", [[{text:"High Qlty",callback_data:"cmp_80"}], [{text:"Medium",callback_data:"cmp_50"}], [{text:"Smallest Size",callback_data:"cmp_20"}]]);
  if (action === "m_batch") return sendButtons(chatId, "📦 *Batch Queue:*", [[{text:"⬇️ Download ZIP",callback_data:"b_zip"},{text:"🗑 Clear",callback_data:"b_clr"}]]);
  if (action === "qr_gen") {
    await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 });
    return sendMessage(chatId, "⌨️ Type the text or link for your QR code:");
  }
  if (action === "remove_bg" && chatId !== ADMIN_ID) return sendMessage(chatId, "⛔ Admin Only Feature.");
  if (action === "b_clr") { await redis.del(`batch:${chatId}`); return sendMessage(chatId, "🗑 Queue cleared."); }

  await processTask(chatId, action);
}

/* ────────────── TASK PROCESSOR ────────────── */
async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return sendMessage(chatId, "⚠️ Session expired.");

  try {
    const url = await getUrl(fileId);

    // QR SCANNER
    if (action === "qr_scan") {
      const img = await axios.get(url, { responseType: 'arraybuffer' });
      const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return sendMessage(chatId, code ? `✅ *RESULT:* \`${code.data}\`` : "❌ No QR code found.");
    }

    // BATCH SYSTEM
    if (action === "b_add") {
      const len = await redis.llen(`batch:${chatId}`);
      if (len >= 10) return sendMessage(chatId, "⛔ Batch Full.");
      await redis.rpush(`batch:${chatId}`, fileId);
      return sendMessage(chatId, `✅ Added to Batch (${len + 1}/10).`);
    }

    if (action === "b_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      if (!ids.length) return sendMessage(chatId, "⚠️ Batch is empty.");
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const u = await getUrl(id);
        const r = await axios.get(u, { responseType: 'arraybuffer' });
        archive.append(r.data, { name: `file_${i+1}.jpg` });
      }
      archive.finalize();
      return sendFile(chatId, stream, "Studio_Batch.zip");
    }

    // BG REMOVAL
    if (action === "remove_bg") {
      const res = await axios.post("https://api.remove.bg/v1.0/removebg", { image_url: url, size: "auto" }, { headers: { "X-API-Key": process.env.REMOVE_BG_KEY }, responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(res.data), "No_BG.png");
    }

    // UNLIMITED PDF/DOC CONVERSION (RENDER FIX)
    if (["doc_pdf", "epub_pdf", "pdf_jpg", "pdf_docx"].includes(action)) {
      const form = new FormData();
      const fileStream = await axios.get(url, { responseType: 'stream' });
      
      let endpoint = "/forms/libreoffice/convert"; 
      let inputFileName = "document.docx";

      if (action.startsWith("pdf_")) {
        inputFileName = "input.pdf";
      } else if (action === "epub_pdf") {
        inputFileName = "book.epub";
      }

      form.append('files', fileStream.data, { filename: inputFileName });
      
      const res = await axios.post(`${GOTENBERG_URL}${endpoint}`, form, {
        headers: form.getHeaders(),
        responseType: 'arraybuffer'
      });

      return sendFile(chatId, Buffer.from(res.data), `Studio_Output.${action.split('_')[1]}`);
    }

    // IMAGE PROCESSING (SHARP)
    const imgData = await axios.get(url, { responseType: 'arraybuffer' });
    let buf;
    
    if (action.startsWith("fmt_")) {
      const f = action.split("_")[1];
      if (f === "sticker") {
        const sBuf = await sharp(imgData.data).resize(512,512,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp().toBuffer();
        const sForm = new FormData();
        sForm.append("chat_id", chatId);
        sForm.append("sticker", sBuf, { filename: "sticker.webp" });
        return axios.post(`https://api.telegram.org/bot${TOKEN}/sendSticker`, sForm, { headers: sForm.getHeaders() });
      }
      buf = (f === "pdf") ? await imageToPdf(imgData.data) : await sharp(imgData.data)[f]().toBuffer();
      return sendFile(chatId, buf, `Converted.${f}`);
    }

    if (action.startsWith("res_")) {
      const r = action.split("_")[1];
      const m = await sharp(imgData.data).metadata();
      let w = m.width, h = m.height;
      if (r === "2:3") { w/h > 2/3 ? w = Math.round(h*(2/3)) : h = Math.round(w*(3/2)); }
      else if (r === "16:9") { w/h > 16/9 ? w = Math.round(h*(16/9)) : h = Math.round(w*(9/16)); }
      else if (r === "1:1") { w = Math.min(w, h); h = w; }
      buf = await sharp(imgData.data).resize(w, h, { fit: 'cover' }).jpeg().toBuffer();
      return sendFile(chatId, buf, `Resized_${r.replace(':','x')}.jpg`);
    }

    if (action.startsWith("cmp_")) {
      const qual = parseInt(action.split("_")[1]);
      buf = await sharp(imgData.data).jpeg({ quality: qual }).toBuffer();
      return sendFile(chatId, buf, `Compressed.jpg`);
    }

  } catch (e) { 
    console.error("Task Error:", e.message);
    sendMessage(chatId, "⚠️ *Engine Error.* Render may be booting up or the file format is unsupported."); 
  }
}

/* ────────────── HELPERS ────────────── */
async function imageToPdf(data) {
  const pdf = await PDFDocument.create();
  const emb = await pdf.embedJpg(data);
  const pg = pdf.addPage([emb.width, emb.height]);
  pg.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
  return Buffer.from(await pdf.save());
}

async function sendHelp(id) {
  const h = "📖 *STUDIO GUIDE*\n\n1. *Images:* Send any photo to convert, resize, or compress.\n2. *Documents:* PDF, DOCX, or EPUB conversion.\n3. *QR:* Scan image or Generate via menu.\n4. *Batch:* Add images to download as ZIP.";
  return sendMessage(id, h);
}

async function getUrl(id) {
  const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${id}`);
  return `https://api.telegram.org/file/bot${TOKEN}/${r.data.result.file_path}`;
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

