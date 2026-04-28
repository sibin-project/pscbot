require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenAI } = require("@google/genai");
const cron = require('node-cron');

// --- Configuration ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TOPICS = ['General Knowledge', 'Current Affairs', 'Mathematics', 'English Grammar', 'Malayalam', 'General Science', 'Indian Constitution'];
const LEVELS = ['SSLC Level', 'Plus Two Level', 'Degree Level'];
const MODEL_NAME = "gemini-3-flash-preview";
const CHANNEL_LINK = "https://t.me/kerala_psc_study";
let minutesUntilNextPost = 10;

// --- Database Connection ---
let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
  isConnected = true;
  console.log('✅ Connected to MongoDB');
}

// --- Global Error Handler ---
bot.catch((err, ctx) => {
  console.error(`❌ Global Bot Error:`, err.message);
});

// --- MongoDB Models ---
const QuestionSchema = new mongoose.Schema({
  question: { type: String, unique: true, required: true },
  options: [String],
  correct_option_index: Number,
  topic: String,
  level: String,
  is_posted: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now }
});

const ChatSchema = new mongoose.Schema({
  chat_id: { type: String, unique: true },
  title: String,
  type: String,
  invite_link: String
});

const StateSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const Question = mongoose.model('Question', QuestionSchema);
const Chat = mongoose.model('Chat', ChatSchema);
const State = mongoose.model('State', StateSchema);

// --- LLM Logic ---
async function generateQuestions(level, topic, count = 10) {
  try {
    await connectDB();
    const rateLimitState = await State.findOne({ key: 'rate_limit_pause' });
    if (rateLimitState && rateLimitState.value.paused_until > Date.now()) return [];

    const historyState = await State.findOne({ key: 'history' });
    const history = (historyState?.value || []).slice(-50).join(', ');
    const prompt = `Generate ${count} unique Kerala PSC questions. Level: ${level}, Topic: ${topic}. History: [${history}]`;

    const response = await ai.models.generateContent({ model: MODEL_NAME, contents: prompt });
    const text = response.text;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']') + 1;
    if (start === -1) return [];

    const questions = JSON.parse(text.substring(start, end));
    for (const q of questions) {
      try { await Question.create(q); } catch (e) { }
    }
    await State.updateOne({ key: 'history' }, { value: [...(historyState?.value || []), ...questions.map(q => q.question)].slice(-50) }, { upsert: true });
    return questions;
  } catch (err) {
    if (err.message.includes('quota') || err.message.includes('429')) {
      await State.updateOne({ key: 'rate_limit_pause' }, { value: { paused_until: Date.now() + (60 * 60 * 1000) } }, { upsert: true });
    }
    return [];
  }
}

// --- Helper for Migration ---
async function handleMigration(err, oldId) {
  if (err.response && err.response.parameters && err.response.parameters.migrate_to_chat_id) {
    const newId = err.response.parameters.migrate_to_chat_id.toString();
    try {
      const existing = await Chat.findOne({ chat_id: newId });
      if (existing) await Chat.deleteOne({ chat_id: oldId });
      else await Chat.updateOne({ chat_id: oldId }, { chat_id: newId });
    } catch (e) {}
    return newId;
  }
  return null;
}

// --- Bot Actions ---
async function postToAllChats() {
  try {
    await connectDB();
    const chats = await Chat.find();
    if (chats.length === 0) return;

    let q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    if (!q) {
      console.log("⚠️ Out of questions! Attempting to generate more...");
      await generateQuestions(LEVELS[0], TOPICS[0], 5);
      q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    }
    
    if (!q) {
      console.log("❌ Skip: No questions available.");
      return;
    }

    const sourceId = process.env.FORWARD_SOURCE_ID;
    if (!sourceId) return;

    const adminMsg = await bot.telegram.sendPoll(sourceId, q.question, q.options, {
      type: 'quiz', correct_option_id: q.correct_option_index, is_anonymous: true,
      explanation: `Correct answer: ${q.options[q.correct_option_index]}`
    });
    await State.updateOne({ key: `poll_${adminMsg.poll.id}` }, { value: { chat_id: sourceId, voted: false } }, { upsert: true });

    for (const chat of chats.filter(c => c.chat_id !== sourceId && c.type !== 'private')) {
      try {
        await bot.telegram.forwardMessage(chat.chat_id, sourceId, adminMsg.message_id);
      } catch (err) {
        const targetId = await handleMigration(err, chat.chat_id) || chat.chat_id;
        try { await bot.telegram.copyMessage(targetId, sourceId, adminMsg.message_id); } catch (e) {}
      }
    }
    q.is_posted = true;
    await q.save();
    console.log("✅ Poll posted.");
  } catch (err) { console.error("Post Error:", err.message); }
  finally { minutesUntilNextPost = 10; }
}

// --- Handlers ---
bot.start(async (ctx) => {
  await connectDB();
  await Chat.updateOne({ chat_id: ctx.chat.id.toString() }, { title: ctx.chat.title || "User", type: ctx.chat.type }, { upsert: true });
  await ctx.reply('Welcome! Kerala PSC questions will be posted here every 10 minutes.');
});

bot.on('my_chat_member', async (ctx) => {
  await connectDB();
  const chat = ctx.myChatMember.chat;
  const status = ctx.myChatMember.new_chat_member.status;
  if (status === 'administrator' || status === 'member') {
    await Chat.updateOne({ chat_id: chat.id.toString() }, { title: chat.title || "Unknown", type: chat.type }, { upsert: true });
  } else {
    await Chat.deleteOne({ chat_id: chat.id.toString() });
  }
});

bot.command(['postnow', 'gen'], async (ctx) => { await postToAllChats(); });

bot.command('users', async (ctx) => {
  if (ctx.from.id.toString() !== process.env.FORWARD_SOURCE_ID) return;
  await connectDB();
  const chats = await Chat.find();
  let response = `📊 *Registered Users*: ${chats.length}\n\n`;
  chats.forEach((c, i) => { response += `${i+1}. ${c.title} (${c.type})\n`; });
  ctx.replyWithMarkdown(response);
});

bot.on('poll', async (ctx) => {
  const poll = ctx.poll;
  if (!poll || poll.total_voter_count === 0) return;
  await connectDB();
  const pollState = await State.findOne({ key: `poll_${poll.id}` });
  if (pollState && !pollState.value.voted) {
    await State.updateOne({ key: `poll_${poll.id}` }, { 'value.voted': true });
    const marathon = await State.findOne({ key: `marathon_${pollState.value.chat_id}` });
    if (marathon && marathon.value.count < marathon.value.target) {
      marathon.value.count++; marathon.markModified('value'); await marathon.save();
      setTimeout(async () => {
        const q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
        if (q) {
          const msg = await bot.telegram.sendPoll(pollState.value.chat_id, q.question, q.options, { type: 'quiz', correct_option_id: q.correct_option_index, is_anonymous: true });
          await State.updateOne({ key: `poll_${msg.poll.id}` }, { value: { chat_id: pollState.value.chat_id, voted: false } }, { upsert: true });
          q.is_posted = true; await q.save();
        }
      }, 3000);
    }
  }
});

// --- Vercel Serverless Export ---
module.exports = async (req, res) => {
  await connectDB();
  
  if (req.url === '/api/cron') {
    await postToAllChats();
    return res.status(200).send('Cron Job Executed');
  }

  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  res.status(200).send('Bot is online!');
};

// --- Koyeb / Local Persistent Server ---
if (!process.env.VERCEL) {
  const express = require('express');
  const app = express();
  
  app.get('/', (req, res) => res.send('Bot is running! 🚀'));
  
  const PORT = process.env.PORT || 8000;
  app.listen(PORT, () => console.log(`🌍 Health check server on port ${PORT}`));

  connectDB().then(() => {
    bot.launch();
    console.log('✅ Bot is running');
    setInterval(() => {
      minutesUntilNextPost--;
      if (minutesUntilNextPost <= 0) postToAllChats();
      else console.log(`⏱️ Next poll in ${minutesUntilNextPost}m...`);
    }, 60000);
    cron.schedule('0 * * * *', () => generateQuestions(LEVELS[0], TOPICS[0], 50));
  });
}
