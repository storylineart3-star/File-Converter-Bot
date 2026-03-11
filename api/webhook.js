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

/* ---------------- MESSAGE ---------------- */

if (update.message) {

const chatId = update.message.chat.id;
await redis.sadd("users", chatId);

/* ---------- RATE LIMIT ---------- */

const rateKey = `rate:${chatId}`;
const count = await redis.incr(rateKey);

if (count === 1) await redis.expire(rateKey, 60);

if (count > 10) {
  await sendMessage(chatId,"⚠️ Too many requests. Wait 60 seconds.");
  return res.status(200).send("ok");
}

/* ---------- JOIN CHECK ---------- */

if (!(await isUserJoined(chatId))) {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Join our channel to use this bot",
reply_markup:{
inline_keyboard:[
[{text:"Join Channel",url:`https://t.me/${CHANNEL.replace("@","")}`}],
[{text:"I Joined",callback_data:"check_join"}]
]
}
});

return res.status(200).send("ok");
}

/* ---------- START ---------- */

if (update.message.text === "/start") {

await sendMessage(chatId,
`👋 Welcome to File Converter Bot

Send an image and choose what to do.

Available tools:

• Convert Format
• Resize Image
• Compress Image
• Create Sticker
• Convert to PDF
• Remove Metadata

Use /menu anytime`
);

}

/* ---------- MENU ---------- */

if (update.message.text === "/menu") {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Choose action",
reply_markup:{
inline_keyboard:[
[{text:"Convert Format",callback_data:"convert"}],
[{text:"Resize Image",callback_data:"resize"}],
[{text:"Compress Image",callback_data:"compress"}],
[{text:"Create Sticker",callback_data:"sticker"}],
[{text:"Convert to PDF",callback_data:"pdf"}],
[{text:"Remove Metadata",callback_data:"meta"}]
]
}
});

}

/* ---------- ADMIN STATS ---------- */

if (update.message.text === "/stats" && chatId === ADMIN_ID) {

const users = await redis.smembers("users");
const conversions = await redis.get("stats:convert") || 0;
const resize = await redis.get("stats:resize") || 0;
const pdf = await redis.get("stats:pdf") || 0;
const sticker = await redis.get("stats:sticker") || 0;

await sendMessage(chatId,
`📊 Bot Stats

Users: ${users.length}
Conversions: ${conversions}
Resized: ${resize}
PDF Created: ${pdf}
Stickers: ${sticker}`
);

}

/* ---------- BROADCAST ---------- */

if (update.message.text?.startsWith("/broadcast") && chatId === ADMIN_ID) {

const text = update.message.text.replace("/broadcast ","");
const users = await redis.smembers("users");

for (const id of users) {
try{ await sendMessage(id,text); }catch{}
}

}

/* ---------- IMAGE RECEIVED ---------- */

if (update.message.photo) {

const fileId = update.message.photo.pop().file_id;
userFiles[chatId] = fileId;

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Choose action",
reply_markup:{
inline_keyboard:[
[{text:"Convert Format",callback_data:"convert"}],
[{text:"Resize Image",callback_data:"resize"}],
[{text:"Compress Image",callback_data:"compress"}],
[{text:"Create Sticker",callback_data:"sticker"}],
[{text:"Convert to PDF",callback_data:"pdf"}],
[{text:"Remove Metadata",callback_data:"meta"}]
]
}
});

}

}

/* ---------------- CALLBACK HANDLER ---------------- */

if (update.callback_query) {

const chatId = update.callback_query.message.chat.id;
const action = update.callback_query.data;

/* ---------- JOIN CONFIRM ---------- */

if (action === "check_join") {

if (await isUserJoined(chatId)) {
await sendMessage(chatId,"✅ You can now use the bot!");
}else{
await sendMessage(chatId,"❌ Please join first.");
}

}

/* ---------- FORMAT MENU ---------- */

if (action === "convert") {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Choose format",
reply_markup:{
inline_keyboard:[
[{text:"PNG",callback_data:"png"}],
[{text:"JPG",callback_data:"jpg"}],
[{text:"WEBP",callback_data:"webp"}]
]
}
});

}

/* ---------- RESIZE MENU ---------- */

if (action === "resize") {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Resize Image",
reply_markup:{
inline_keyboard:[
[{text:"512x512",callback_data:"512"}],
[{text:"1024x1024",callback_data:"1024"}],
[{text:"2:3 Poster",callback_data:"poster"}]
]
}
});

}

/* ---------- COMPRESS MENU ---------- */

if (action === "compress") {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Compression level",
reply_markup:{
inline_keyboard:[
[{text:"High",callback_data:"c80"}],
[{text:"Medium",callback_data:"c60"}],
[{text:"Low",callback_data:"c40"}]
]
}
});

}

/* ---------- IMAGE PROCESS ---------- */

const fileId = userFiles[chatId];

if (!fileId) return res.status(200).send("ok");

const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.data.result.file_path}`;

const image = await axios.get(fileUrl,{responseType:"arraybuffer"});
let buffer;

/* FORMAT */

if (["png","jpg","webp"].includes(action)) {

buffer = await sharp(image.data)[action === "jpg" ? "jpeg" : action]().toBuffer();
await redis.incr("stats:convert");

}

/* RESIZE */

if (action === "512") {
buffer = await sharp(image.data).resize(512,512).toBuffer();
await redis.incr("stats:resize");
}

if (action === "1024") {
buffer = await sharp(image.data).resize(1024,1024).toBuffer();
await redis.incr("stats:resize");
}

if (action === "poster") {
buffer = await sharp(image.data).resize(1200,1800).toBuffer();
await redis.incr("stats:resize");
}

/* COMPRESS */

if (action?.startsWith("c")) {
const q = parseInt(action.replace("c",""));
buffer = await sharp(image.data).jpeg({quality:q}).toBuffer();
}

/* STICKER */

if (action === "sticker") {

buffer = await sharp(image.data).resize(512,512).webp().toBuffer();
await redis.incr("stats:sticker");

const form = new FormData();
form.append("chat_id",chatId);
form.append("sticker",buffer,{filename:"sticker.webp"});

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendSticker`,form);
return res.status(200).send("ok");

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

await redis.incr("stats:pdf");

return res.status(200).send("ok");

}

/* REMOVE META */

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

}catch(e){
console.log(e);
}

res.status(200).send("ok");

}

/* ---------------- HELPERS ---------------- */

async function sendMessage(chatId,text){

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text
});

}

async function isUserJoined(chatId){

try{

const res = await axios.get(
`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${CHANNEL}&user_id=${chatId}`
);

const status = res.data.result.status;

return status === "member" || status === "administrator" || status === "creator";

}catch{
return false;
}

}
