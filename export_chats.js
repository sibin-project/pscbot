require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';
const mongoose = require('mongoose');
const fs = require('fs');

async function exportChats() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB.');

    const ChatSchema = new mongoose.Schema({
      chat_id: String,
      title: String,
      type: String,
      invite_link: String
    });

    const Chat = mongoose.model('Chat', ChatSchema);
    const chats = await Chat.find();

    const data = chats.map(c => ({
      name: c.title,
      id: c.chat_id,
      link: c.invite_link || "N/A",
      type: c.type
    }));

    fs.writeFileSync('registered_chats.json', JSON.stringify(data, null, 2));
    console.log(`✅ Successfully exported ${data.length} chats to registered_chats.json`);
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Export Error:', err);
  }
}

exportChats();
