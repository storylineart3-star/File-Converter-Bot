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
  if (req.method !== "POST") return res.status(200).send("Bot running");
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) { console.error(err); }
  return res.status(200).send("ok");
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  await redis.sadd("users", chatId);
  if (!(await checkJoin(chatId))) {
    return sendMessage(chatId, `❌ Please join ${CHANNEL} to use this bot.`);
  }

  // State Handler for QR Generation
  const state = await redis.get(`state:${chatId}`);
  if (state === "waiting_qr_text" && text) {
    await redis.del(`state:${chatId}`);
    return generateQR(chatId, text);
  }

  if (text === "/start" || text === "/menu") return sendMainMenu(chatId);

  if (msg.photo) {
    const fileId = msg.photo.pop().file_id;
    await redis.set(`file:${chatId}`, fileId, { ex: 3600 });
    return sendMessage(chatId, "✅ Image received! Click /menu to start.");
  }

  // Admin Broadcast/Stats
  if (chatId === ADMIN_ID) {
    if (text === "/stats") {
      const count = await redis.scard("users");
      return sendMessage(chatId, `📊 Total Users: ${count}`);
    }
    if (text?.startsWith("/broadcast")) {
      const m = text.replace("/broadcast ", "");
      const users = await redis.smembers("users");
      for (const id of users) { try { await sendMessage(id, m); } catch(e){} }
      return sendMessage(chatId, "✅ Sent.");
    }
  }
}

async function sendMainMenu(chatId) {
  return sendButtons(chatId, "🛠 *Main Menu*", [
    [{ text: "🔄 Image Converter", callback_data: "m_img" }, { text: "📄 Doc Converter", callback_data: "m_doc" }],
    [{ text: "🔍 QR Tools", callback_data: "m_qr" }, { text: "📦 Batch ZIP", callback_data: "m_batch" }],
    [{ text: "✨ Remove BG (Admin)", callback_data: "remove_bg" }]
  ]);
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  // Menu Navigation
  if (action === "m_img") return sendButtons(chatId, "Image Tools:", [[{text:"PNG",callback_data:"png"},{text:"JPG",callback_data:"jpg"}],[{text:"Sticker",callback_data:"sticker"},{text:"PDF",callback_data:"pdf"}]]);
  if (action === "m_doc") return sendButtons(chatId, "Doc Tools:", [[{text:"Word to PDF",callback_data:"docx_pdf"},{text:"PDF to JPG",callback_data:"pdf_jpg"}],[{text:"EPUB to PDF",callback_data:"epub_pdf"}]]);
  if (action === "m_qr") return sendButtons(chatId, "QR Tools:", [[{text:"Create QR",callback_data:"qr_gen"},{text:"Scan QR",callback_data:"qr_scan"}]]);
  if (action === "m_batch") return sendButtons(chatId, "Batch ZIP:", [[{text:"Add Current to Batch",callback_data:"batch_add"},{text:"Download ZIP",callback_data:"batch_zip"}],[{text:"Clear Batch",callback_data:"batch_clear"}]]);

  if (action === "qr_gen") {
    await redis.set(`state:${chatId}`, "waiting_qr_text", { ex: 300 });
    return sendMessage(chatId, "⌨️ Send the text or link for the QR code:");
  }
  
  if (action === "remove_bg" && chatId !== ADMIN_ID) return sendMessage(chatId, "❌ Admin Only.");

  await processTask(chatId, action);
}

async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.includes("batch")) return sendMessage(chatId, "❌ No image found. Send one first.");

  try {
    const fileUrl = await getFileUrl(fileId);
    
    // 1. QR Scanner
    if (action === "qr_scan") {
      const img = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return sendMessage(chatId, code ? `🔍 Found: ${code.data}` : "❌ No QR code found.");
    }

    // 2. Batch Logic
    if (action === "batch_add") {
      await redis.rpush(`batch:${chatId}`, fileId);
      const len = await redis.llen(`batch:${chatId}`);
      return sendMessage(chatId, `✅ Added. Batch size: ${len}/10`);
    }

    if (action === "batch_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      if (ids.length === 0) return sendMessage(chatId, "Batch empty.");
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const u = await getFileUrl(id);
        const res = await axios.get(u, { responseType: 'arraybuffer' });
        archive.append(res.data, { name: `file_${i+1}.jpg` });
      }
      archive.finalize();
      return sendFile(chatId, stream, "batch.zip");
    }

    // 3. Document/Heavy Conversions (ConvertAPI)
    if (action.includes("_")) {
      const [from, to] = action.split("_");
      const result = await convertapi.convert(to, { File: fileUrl }, from);
      const convRes = await axios.get(result.file.url, { responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(convRes.data), `converted.${to}`);
    }

    // 4. Standard Sharp Tools (Partially hidden for brevity)
    // ... insert your existing sharp/pdf logic here ...

  } catch (e) { sendMessage(chatId, "❌ Error: " + e.message); }
}

/* HELPERS */
async function getFileUrl(id) {
  const res = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${id}`);
  return `https://api.telegram.org/file/bot${TOKEN}/${res.data.result.file_path}`;
}

async function sendFile(chatId, buffer, filename) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", buffer, { filename });
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`, form, { headers: form.getHeaders() });
}

async function checkJoin(uId) {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${uId}`);
    return ["member", "administrator", "creator"].includes(r.data.result.status);
  } catch (e) { return true; }
}

async function sendMessage(cId, text) {
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: cId, text, parse_mode: "Markdown" });
}

async function sendButtons(cId, text, buttons) {
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: cId, text, reply_markup: { inline_keyboard: buttons } });
}

async function generateQR(chatId, text) {
  const buf = await QRCode.toBuffer(text);
  return sendFile(chatId, buf, "qrcode.png");
}
