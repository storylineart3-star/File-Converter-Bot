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

  const state = await redis.get(`state:${chatId}`);
  if (state === "wait_qr" && text) {
    await redis.del(`state:${chatId}`);
    const buf = await QRCode.toBuffer(text);
    return sendFile(chatId, buf, "qrcode.png");
  }

  if (text === "/start" || text === "/menu") {
    return sendButtons(chatId, "🛠 *Main Menu*", [
      [{ text: "🖼 Image Tools", callback_data: "m_img" }, { text: "📄 Doc Tools", callback_data: "m_doc" }],
      [{ text: "🔍 QR Tools", callback_data: "m_qr" }, { text: "📦 Batch ZIP", callback_data: "m_batch" }],
      [{ text: "✨ Remove BG (Admin)", callback_data: "remove_bg" }]
    ]);
  }

  if (msg.photo) {
    const fileId = msg.photo.pop().file_id;
    await redis.set(`file:${chatId}`, fileId, { ex: 3600 });
    return sendMessage(chatId, "✅ Image saved! Open /menu to process.");
  }
  
  if (chatId === ADMIN_ID && text?.startsWith("/broadcast ")) {
    const m = text.replace("/broadcast ", "");
    const users = await redis.smembers("users");
    for (const id of users) { try { await sendMessage(id, m); } catch(e){} }
    return sendMessage(chatId, "✅ Done.");
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  const menus = {
    m_img: [[{text:"PNG",callback_data:"png"},{text:"JPG",callback_data:"jpg"}],[{text:"Sticker",callback_data:"sticker"},{text:"PDF",callback_data:"pdf"}]],
    m_doc: [[{text:"Word→PDF",callback_data:"docx_pdf"},{text:"PDF→JPG",callback_data:"pdf_jpg"}],[{text:"EPUB→PDF",callback_data:"epub_pdf"},{text:"TXT→PDF",callback_data:"txt_pdf"}]],
    m_qr: [[{text:"Create QR",callback_data:"qr_gen"},{text:"Scan QR",callback_data:"qr_scan"}]],
    m_batch: [[{text:"Add to Batch",callback_data:"b_add"},{text:"ZIP (Max 10)",callback_data:"b_zip"}],[{text:"Clear",callback_data:"b_clr"}]]
  };

  if (menus[action]) return sendButtons(chatId, "Select option:", menus[action]);
  if (action === "qr_gen") {
    await redis.set(`state:${chatId}`, "wait_qr", { ex: 300 });
    return sendMessage(chatId, "⌨️ Send text for the QR:");
  }
  if (action === "remove_bg" && chatId !== ADMIN_ID) return sendMessage(chatId, "❌ Admin Only.");

  await processTask(chatId, action);
}

async function processTask(chatId, action) {
  const fileId = await redis.get(`file:${chatId}`);
  if (!fileId && !action.startsWith("b_")) return sendMessage(chatId, "❌ Send an image/file first.");

  try {
    const url = await getUrl(fileId);
    if (action === "qr_scan") {
      const img = await axios.get(url, { responseType: 'arraybuffer' });
      const { data, info } = await sharp(img.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return sendMessage(chatId, code ? `🔍 Content: ${code.data}` : "❌ No QR found.");
    }

    if (action === "b_add") {
      const len = await redis.llen(`batch:${chatId}`);
      if (len >= 10) return sendMessage(chatId, "❌ Limit reached (10).");
      await redis.rpush(`batch:${chatId}`, fileId);
      return sendMessage(chatId, `✅ Added (${len + 1}/10).`);
    }

    if (action === "b_zip") {
      const ids = await redis.lrange(`batch:${chatId}`, 0, -1);
      const archive = archiver('zip');
      const stream = new PassThrough();
      archive.pipe(stream);
      for (const [i, id] of ids.entries()) {
        const u = await getUrl(id);
        const r = await axios.get(u, { responseType: 'arraybuffer' });
        archive.append(r.data, { name: `file_${i+1}.jpg` });
      }
      archive.finalize();
      return sendFile(chatId, stream, "batch.zip");
    }

    if (action === "remove_bg") {
      const res = await axios.post("https://api.remove.bg/v1.0/removebg", { image_url: url, size: "auto" }, { headers: { "X-API-Key": process.env.REMOVE_BG_KEY }, responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(res.data), "no_bg.png");
    }

    if (action.includes("_")) {
      const [from, to] = action.split("_");
      const res = await convertapi.convert(to, { File: url }, from);
      const data = await axios.get(res.file.url, { responseType: 'arraybuffer' });
      return sendFile(chatId, Buffer.from(data.data), `output.${to}`);
    }

    // Default Sharp conversions
    const img = await axios.get(url, { responseType: 'arraybuffer' });
    let buf = (action === "sticker") ? await sharp(img.data).resize(512,512).webp().toBuffer() : await sharp(img.data)[action]().toBuffer();
    return sendFile(chatId, buf, `result.${action}`);

  } catch (e) { sendMessage(chatId, "⚠️ Error: " + e.message); }
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
  return axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { chat_id: id, text, reply_markup: { inline_keyboard: buttons } });
}
