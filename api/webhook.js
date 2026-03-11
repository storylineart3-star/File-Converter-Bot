import axios from "axios";

const TOKEN = process.env.BOT_TOKEN;

export default async function handler(req, res) {

if (req.method !== "POST") {
  return res.status(200).send("Bot running");
}

const update = req.body;

if(update.message){

const chatId = update.message.chat.id;

await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
chat_id: chatId,
text: "📂 Send me a file (image or document) and I will convert it."
});

}

res.status(200).send("ok");

}
