require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';
const mongoose = require('mongoose');

async function deregister() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB.');

    const ChatSchema = new mongoose.Schema({
      chat_id: { type: String, unique: true }
    });
    const Chat = mongoose.model('Chat', ChatSchema);

    const result = await Chat.deleteOne({ chat_id: "-1003901486996" });
    
    if (result.deletedCount > 0) {
      console.log('✅ Successfully deregistered "ai chat" (-1003901486996)');
    } else {
      console.log('❓ Chat was not found in the database.');
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

deregister();
