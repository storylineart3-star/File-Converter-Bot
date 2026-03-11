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
  } catch (err) { console.error("Error:", err.message); }
  return res.status(200).send("ok");
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  await redis.sadd("users", chatId);
  if (!(await checkJoin(chatId))) return sendMessage(chatId, `❌ Please join ${CHANNEL} to use this bot.`);

  // 1. Handle Text / Start
  if (text === "/start" || text === "/menu") {
    return sendButtons(chatId, "👋 *Welcome!*\n\nI am your All-in-One File Converter.\n\n*Just send any Image, PDF, or Document* and I will show you what I can do!", [
      [{ text: "🔍 QR Generator", callback_data: "qr_gen" }],
      [{ text: "📦 My ZIP Batch", callback_data: "m_batch" }]
    ]);
  }

  // 2. Handle QR Text State
  if ((await redis.get(`state:${chatId}`)) === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "qrcode.png");
  }

  // 3. FILE DETECTION LOGIC
  let fileId, type, menuTitle, buttons;

  if (msg.photo) {
    fileId = msg.photo.pop().file_id;
    type = "img";
    menuTitle = "🖼 *Image Detected!* Choose an action:";
    buttons = [
      [{text:"PNG",callback_data:"png"}, {text:"JPG",callback_data:"jpg"}, {text:"WEBP",callback_data:"webp"}],
      [{text:"Sticker",callback_data:"sticker"}, {text:"PDF",callback_data:"pdf"}],
      [{text:"✨ Remove BG (Admin)",callback_data:"remove_bg"}, {text:"🔍 Scan QR",callback_data:"qr_scan"}],
      [{text:"➕ Add to Batch ZIP",callback_data:"b_add"}]
    ];
  } 
  else if (msg.document) {
    fileId = msg.document.file_id;
    const fileName = msg.document.file_name.toLowerCase();
    
    if (fileName.endsWith(".pdf")) {
      type = "pdf";
      menuTitle = "📄 *PDF Detected!*";
      buttons = [[{text:"PDF → JPG",callback_data:"pdf_jpg"}, {text:"PDF → DOCX",callback_data:"pdf_docx"}]];
    } else if (fileName.endsWith(".docx") || fileName.endsWith(".doc")) {
      type = "doc";
      menuTitle = "📝 *Word Doc Detected!*";
      buttons = [[{text:"Word → PDF",callback_data:"docx_pdf"}, {text:"Word → TXT",callback_data:"docx_txt"}]];
    } else if (fileName.endsWith(".epub")) {
      type = "epub";
      menuTitle = "📚 *Ebook Detected!*";
      buttons = [[{text:"EPUB → PDF",callback_data:"epub_pdf"}, {text:"EPUB → TXT",callback_data:"epub_txt"}]];
    }
  }

  if (fileId) {
    await redis.set(`file:${chatId}`, fileId, { ex: 3600 });
    return sendButtons(chatId, menuTitle, buttons);
  }
}
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (action === "m_batch") return sendButtons(chatId, "Batch ZIP:", [[{text:"Download ZIP",callback_data:"b_zip"},{text:"Clear",callback_data:"b_clr"}]]);
  if (action === "qr_gen") {
    await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 });
    return sendMessage(chatId, "⌨️ Send the text or link to generate QR:");
  }
  if (action === "remove_bg" && chatId !== ADMIN_ID) return sendMessage(chatId, "❌ Background removal is for Admin use only.");

  await processTask(chatId, action);
}

async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return sendMessage(chatId, "❌ Please send a file first.");

  try {
    const url = await getUrl(fileId);

    // LIMIT CHECK for ConvertAPI / Remove.bg
    if (action.includes("_") || action === "remove_bg") {
      const dayKey = `limit:${new Date().toISOString().split('T')[0]}`;
      const used = await redis.incr(dayKey);
      await redis.expire(dayKey, 86400);
      if (used > 25 && chatId !== ADMIN_ID) return sendMessage(chatId, "⚠️ Daily conversion limit reached. Try again tomorrow!");
    }

    if (action === "qr_scan") {
      const img = await axios.get(url, { responseType: 'arraybuffer' });
      const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return sendMessage(chatId, code ? `🔍 QR Content:\n\n\`${code.data}\`` : "❌ No QR code found.");
    }

    if (action === "b_add") {
      const len = await redis.llen(`batch:${chatId}`);
      if (len >= 10) return sendMessage(chatId, "❌ ZIP limit reached (Max 10).");
      await redis.rpush(`batch:${chatId}`, fileId);
      return sendMessage(chatId, `✅ Added to Batch (${len + 1}/10). You can send more or click "My ZIP Batch" to download.`);
    }

    if (action === "b_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      if (!ids.length) return sendMessage(chatId, "Batch is empty.");
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const u = await getUrl(id);
        const r = await axios.get(u, { responseType: 'arraybuffer' });
        archive.append(r.data, { name: `image_${i+1}.jpg` });
      }
      archive.finalize();
      return sendFile(chatId, stream, "batch_images.zip");
    }

    if (action === "remove_bg") {
      const res = await axios.post("https://api.remove.bg/v1.0/removebg", { image_url: url, size: "auto" }, { headers: { "X-API-Key": process.env.REMOVE_BG_KEY }, responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(res.data), "removed_bg.png");
    }

    // ConvertAPI Logic
    if (action.includes("_")) {
      const [from, to] = action.split("_");
      const res = await convertapi.convert(to, { File: url }, from);
      const data = await axios.get(res.file.url, { responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(data.data), `converted.${to}`);
    }

    // Sharp Conversions
    const img = await axios.get(url, { responseType: 'arraybuffer' });
    let buf;
    if (action === "sticker") buf = await sharp(img.data).resize(512,512).webp().toBuffer();
    else if (action === "pdf") {
      const pdfDoc = await PDFDocument.create();
      const imgP = await pdfDoc.embedJpg(img.data);
      const page = pdfDoc.addPage([imgP.width, imgP.height]);
      page.drawImage(imgP, { x: 0, y: 0, width: imgP.width, height: imgP.height });
      buf = Buffer.from(await pdfDoc.save());
    } else {
      buf = await sharp(img.data)[action]().toBuffer();
    }
    return sendFile(chatId, buf, `converted.${action === "sticker" ? "webp" : action}`);

  } catch (e) { sendMessage(chatId, "⚠️ Error processing file. Make sure it's not too large."); }
}

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

