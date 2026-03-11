import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";

const TOKEN = process.env.BOT_TOKEN;

let userFiles = {};

export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(200).send("Bot running");
}

const update = req.body;

try {

if(update.message){

const chatId = update.message.chat.id;

if(update.message.photo){

const fileId = update.message.photo.pop().file_id;

userFiles[chatId] = fileId;

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id:chatId,
text:"Choose format:",
reply_markup:{
inline_keyboard:[
[{text:"PNG",callback_data:"png"}],
[{text:"JPG",callback_data:"jpg"}],
[{text:"WEBP",callback_data:"webp"}]
]
}
});

}

}

if(update.callback_query){

const chatId = update.callback_query.message.chat.id;
const format = update.callback_query.data;
const fileId = userFiles[chatId];

const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
const filePath = fileInfo.data.result.file_path;

const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

const image = await axios.get(fileUrl,{responseType:"arraybuffer"});

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

const form = new FormData();

form.append("chat_id",chatId);
form.append("document",output,{filename:`converted.${format}`});

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendDocument`,
form,
{headers:form.getHeaders()}
);

}

} catch(e){}

res.status(200).send("ok");

}
