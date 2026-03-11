import axios from "axios";
import sharp from "sharp";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 2067674349; // replace with your Telegram ID

let userFiles = {};
let users = new Set();

export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(200).send("Bot running");
}

const update = req.body;

try {

/* ---------------- MESSAGE HANDLER ---------------- */

if(update.message){

const chatId = update.message.chat.id;

users.add(chatId);

/* -------- START MESSAGE -------- */

if(update.message.text === "/start"){

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendMessage`,
{
chat_id:chatId,
text:`👋 Welcome to File Converter Bot

Send an image and choose format:

🟢 PNG
🟢 JPG
🟢 WEBP

Just send a photo to start converting.`
}
);

}

/* -------- BROADCAST -------- */

if(update.message.text?.startsWith("/broadcast")){

if(chatId !== ADMIN_ID){
return res.status(200).send("ok");
}

const message = update.message.text.replace("/broadcast ","");

for(const id of users){

try{

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendMessage`,
{
chat_id:id,
text:message
}
);

}catch(e){}

}

}

/* -------- IMAGE RECEIVED -------- */

if(update.message.photo){

const fileId = update.message.photo.pop().file_id;

userFiles[chatId] = fileId;

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendMessage`,
{
chat_id:chatId,
text:"Choose format:",
reply_markup:{
inline_keyboard:[
[{text:"PNG",callback_data:"png"}],
[{text:"JPG",callback_data:"jpg"}],
[{text:"WEBP",callback_data:"webp"}]
]
}
}
);

}

}

/* ---------------- BUTTON CLICK ---------------- */

if(update.callback_query){

const chatId = update.callback_query.message.chat.id;
const format = update.callback_query.data;

const fileId = userFiles[chatId];

const fileInfo = await axios.get(
`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`
);

const filePath = fileInfo.data.result.file_path;

const fileUrl =
`https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

const image = await axios.get(fileUrl,{
responseType:"arraybuffer"
});

let output;

if(format==="png"){
output = await sharp(image.data).png().toBuffer();
}

if(format==="jpg"){
output = await sharp(image.data).jpeg().toBuffer();
}

if(format==="webp"){
output = await sharp(image.data).webp().toBuffer();
}

/* -------- SEND FILE BACK -------- */

const formData = new FormData();

formData.append("chat_id", chatId);

formData.append(
"document",
new Blob([output], { type: "application/octet-stream" }),
`converted.${format}`
);

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendDocument`,
formData
);

}

}catch(e){

console.log(e.message);

}

res.status(200).send("ok");

}
