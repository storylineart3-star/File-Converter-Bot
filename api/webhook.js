import axios from "axios";
import sharp from "sharp";

const TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(200).send("Bot running");
}

const update = req.body;

if (update.message) {

const chatId = update.message.chat.id;

if (update.message.photo) {

const fileId = update.message.photo.pop().file_id;

const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);

const filePath = fileInfo.data.result.file_path;

const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

const image = await axios.get(fileUrl,{responseType:"arraybuffer"});

const converted = await sharp(image.data).png().toBuffer();

const formData = new FormData();

formData.append("chat_id", chatId);
formData.append("document", new Blob([converted]), "converted.png");

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendDocument`,formData,{
headers: formData.getHeaders()
});

}
else{

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id: chatId,
text: "📂 Send an image and I will convert it to PNG."
});

}

}

res.status(200).send("ok");

}
