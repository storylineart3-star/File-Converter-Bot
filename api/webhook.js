import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";

const TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {

if (req.method !== "POST") {
  return res.status(200).send("Bot running");
}

const update = req.body;

if (!update.message) {
  return res.status(200).send("ok");
}

const chatId = update.message.chat.id;

try {

if (update.message.photo) {

const fileId = update.message.photo.pop().file_id;

const fileInfo = await axios.get(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);

const filePath = fileInfo.data.result.file_path;

const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

const imageResponse = await axios.get(fileUrl,{responseType:"arraybuffer"});

const convertedImage = await sharp(imageResponse.data).png().toBuffer();

const form = new FormData();

form.append("chat_id", chatId);
form.append("document", convertedImage, {
filename: "converted.png"
});

await axios.post(
`https://api.telegram.org/bot${TOKEN}/sendDocument`,
form,
{ headers: form.getHeaders() }
);

}
else {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id: chatId,
text: "📂 Send an image and I will convert it to PNG."
});

}

} catch (error) {

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id: chatId,
text: "⚠️ Conversion failed. Try a smaller image."
});

}

res.status(200).send("ok");

}
