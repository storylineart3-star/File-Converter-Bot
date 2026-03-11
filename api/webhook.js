import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Redis } from "@upstash/redis";
import { PDFDocument } from "pdf-lib";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349;
const CHANNEL = "@StorylineArtNetwork";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

let userFiles = {};

export default async function handler(req, res) {

if (req.method !== "POST") {
  return res.status(200).send("Bot running");
}

const update = req.body;

try {

if (update.message) {
  await handleMessage(update.message);
}

if (update.callback_query) {
  await handleCallback(update.callback_query);
}

} catch (err) {
  console.log(err);
}

res.status(200).send("ok");
}

/* ---------- MESSAGE HANDLER ---------- */

async function handleMessage(msg){

const chatId = msg.chat.id;

await redis.sadd("users", chatId);

/* START */

if (msg.text === "/start") {
await sendMessage(chatId,
`👋 Welcome

Send an image then choose:

• Convert
• Resize
• Compress
• Sticker
• PDF
• Remove metadata

Use /menu anytime`);
}

/* MENU */

if (msg.text === "/menu") {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Choose action",
reply_markup:{
inline_keyboard:[
[{text:"Convert Format",callback_data:"convert"}],
[{text:"Resize",callback_data:"resize"}],
[{text:"Compress",callback_data:"compress"}],
[{text:"Sticker",callback_data:"sticker"}],
[{text:"PDF",callback_data:"pdf"}],
[{text:"Remove Meta",callback_data:"meta"}]
]
}
});

}

/* IMAGE */

if (msg.photo) {

const fileId = msg.photo.pop().file_id;
userFiles[chatId] = fileId;

await sendMessage(chatId,"Image received. Use /menu");

}

}

/* ---------- CALLBACK HANDLER ---------- */

async function handleCallback(query){

const chatId = query.message.chat.id;
const action = query.data;

if (action === "convert") {

await sendButtons(chatId,"Select format",[
[{text:"PNG",callback_data:"png"}],
[{text:"JPG",callback_data:"jpg"}],
[{text:"WEBP",callback_data:"webp"}]
]);

return;

}

if (action === "resize") {

await sendButtons(chatId,"Resize",[
[{text:"512x512",callback_data:"512"}],
[{text:"1024x1024",callback_data:"1024"}],
[{text:"2:3 Poster",callback_data:"poster"}]
]);

return;

}

if (action === "compress") {

await sendButtons(chatId,"Compression",[
[{text:"High",callback_data:"c80"}],
[{text:"Medium",callback_data:"c60"}],
[{text:"Low",callback_data:"c40"}]
]);

return;

}

await processImage(chatId,action);

}

/* ---------- IMAGE PROCESS ---------- */

async function processImage(chatId,action){

const fileId = userFiles[chatId];
if (!fileId) return;

const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);

const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.data.result.file_path}`;

const image = await axios.get(fileUrl,{responseType:"arraybuffer"});

let buffer;

/* FORMAT */

if (["png","jpg","webp"].includes(action)) {

buffer = await sharp(image.data)[action === "jpg" ? "jpeg" : action]().toBuffer();

}

/* RESIZE */

if (action === "512")
buffer = await sharp(image.data).resize(512,512).toBuffer();

if (action === "1024")
buffer = await sharp(image.data).resize(1024,1024).toBuffer();

if (action === "poster")
buffer = await sharp(image.data).resize(1200,1800).toBuffer();

/* COMPRESS */

if (action?.startsWith("c")) {

const q = parseInt(action.replace("c",""));
buffer = await sharp(image.data).jpeg({quality:q}).toBuffer();

}

/* STICKER */

if (action === "sticker") {

buffer = await sharp(image.data).resize(512,512).webp().toBuffer();

const form = new FormData();
form.append("chat_id",chatId);
form.append("sticker",buffer,{filename:"sticker.webp"});

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendSticker`,form);

return;

}

/* PDF */

if (action === "pdf") {

const pdfDoc = await PDFDocument.create();
const img = await pdfDoc.embedPng(await sharp(image.data).png().toBuffer());

const page = pdfDoc.addPage([img.width,img.height]);
page.drawImage(img,{x:0,y:0,width:img.width,height:img.height});

const pdfBytes = await pdfDoc.save();

const form = new FormData();
form.append("chat_id",chatId);
form.append("document",Buffer.from(pdfBytes),{filename:"image.pdf"});

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`,form);

return;

}

/* META REMOVE */

if (action === "meta") {
buffer = await sharp(image.data).withMetadata(false).toBuffer();
}

/* SEND RESULT */

if (buffer) {

const form = new FormData();
form.append("chat_id",chatId);
form.append("document",buffer,{filename:"result.jpg"});

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`,form);

}

}

/* ---------- HELPERS ---------- */

async function sendMessage(chatId,text){

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text
});

}

async function sendButtons(chatId,text,buttons){

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text,
reply_markup:{inline_keyboard:buttons}
});

}
