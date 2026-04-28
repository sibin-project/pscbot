require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenAI } = require("@google/genai");
const cron = require('node-cron');

// --- Configuration ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const TOPICS = ['General Knowledge', 'Current Affairs', 'Mathematics', 'English Grammar', 'Malayalam', 'General Science', 'Indian Constitution'];
const LEVELS = ['SSLC Level', 'Plus Two Level', 'Degree Level'];
const MODEL_NAME = "gemini-3-flash-preview";
const CHANNEL_LINK = "https://t.me/kerala_psc_study";
let minutesUntilNextPost = 10;

// --- Global Error Handler (Critical for 10k+ Users) ---
bot.catch((err, ctx) => {
  console.error(`❌ Global Bot Error for ${ctx.updateType}:`, err.message);
  // Do NOT re-throw, so the bot stays alive
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
    const rateLimitState = await State.findOne({ key: 'rate_limit_pause' });
    if (rateLimitState && rateLimitState.value.paused_until > Date.now()) {
      const remaining = Math.ceil((rateLimitState.value.paused_until - Date.now()) / 1000 / 60);
      console.log(`⏳ Gemini API is paused for ${remaining} more minutes.`);
      return [];
    }

  const historyState = await State.findOne({ key: 'history' });
  const history = (historyState?.value || []).slice(-50).join(', ');

  const prompt = `Generate ${count} unique Kerala PSC multiple choice questions.
    Level: ${level}
    Topic: ${topic}
    
    IMPORTANT: 
    1. Questions and options MUST be in MALAYALAM (മലയാളം) unless Topic is English.
    2. Do NOT repeat or generate anything similar to these recent questions: [${history}]
    3. Ensure every single question is 100% unique and accurate.
    
    Format the response strictly as a JSON ARRAY of objects:
    [
      {
        "question": "text",
        "options": ["A", "B", "C", "D"],
        "correct_option_index": 0-3,
        "topic": "${topic}",
        "level": "${level}"
      }
    ]`;

    console.log(`Attempting generation with ${MODEL_NAME}...`);
    const response = await ai.models.generateContent({ model: MODEL_NAME, contents: prompt });
    const text = response.text;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']') + 1;
    if (start === -1) return [];

    const questions = JSON.parse(text.substring(start, end));
    let savedCount = 0;
    for (const q of questions) {
      try {
        await Question.create(q);
        savedCount++;
      } catch (e) { }
    }
    const newHistory = [...(historyState?.value || []), ...questions.map(q => q.question)].slice(-50);
    await State.updateOne({ key: 'history' }, { value: newHistory }, { upsert: true });
    return questions;
  } catch (err) {
    if (err.message.includes('quota') || err.message.includes('429')) {
      const pauseUntil = Date.now() + (60 * 60 * 1000);
      await State.updateOne({ key: 'rate_limit_pause' }, { value: { paused_until: pauseUntil } }, { upsert: true });
    }
    return [];
  }
}

// --- Helper for Migration ---
async function handleMigration(err, oldId) {
  if (err.response && err.response.parameters && err.response.parameters.migrate_to_chat_id) {
    const newId = err.response.parameters.migrate_to_chat_id.toString();
    console.log(`🔄 Migrating chat from ${oldId} to ${newId}`);
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
    const chats = await Chat.find();
    if (chats.length === 0) return;

    let q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    if (!q) {
      console.log("⚠️ Out of questions! Attempting to generate more...");
      await generateQuestions(LEVELS[0], TOPICS[0], 5);
      q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    }
    
    if (!q) {
      console.log("❌ Skip: No questions available and AI is paused.");
      minutesUntilNextPost = 10;
      return;
    }

    const sourceId = process.env.FORWARD_SOURCE_ID;
    if (!sourceId) return;

    let adminMsg;
    try {
      adminMsg = await bot.telegram.sendPoll(sourceId, q.question, q.options, {
        type: 'quiz',
        correct_option_id: q.correct_option_index,
        is_anonymous: true,
        explanation: `Correct answer: ${q.options[q.correct_option_index]}`
      });
      await State.updateOne({ key: `poll_${adminMsg.poll.id}` }, { value: { chat_id: sourceId, voted: false } }, { upsert: true });
    } catch (err) { return; }

    const otherChats = chats.filter(c => c.chat_id !== sourceId && c.type !== 'private');
    for (const chat of otherChats) {
      let currentId = chat.chat_id;
      try {
        await bot.telegram.forwardMessage(currentId, sourceId, adminMsg.message_id);
      } catch (err) {
        const migratedId = await handleMigration(err, currentId);
        const targetId = migratedId || currentId;
        try {
          await bot.telegram.copyMessage(targetId, sourceId, adminMsg.message_id);
        } catch (e) {}
      }
    }
    q.is_posted = true;
    await q.save();
    console.log("✅ Poll posted successfully to all chats.");
  } catch (err) { 
    console.error("PostToAll Error:", err.message); 
  } finally {
    minutesUntilNextPost = 10; // Always reset timer
  }
}

// --- Handlers ---
bot.start(async (ctx) => {
  try {
    let invite_link = "";
    try {
      const fullChat = await ctx.getChat();
      invite_link = fullChat.invite_link || "";
    } catch (e) {}
    await Chat.updateOne({ chat_id: ctx.chat.id.toString() }, { title: ctx.chat.title || "User", type: ctx.chat.type, invite_link }, { upsert: true });
    await ctx.reply('Welcome! Kerala PSC questions will be posted here every 10 minutes.');
  } catch (e) {}
});

bot.on('my_chat_member', async (ctx) => {
  try {
    const chat = ctx.myChatMember.chat;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'administrator' || status === 'member') {
      await Chat.updateOne({ chat_id: chat.id.toString() }, { title: chat.title || "Unknown", type: chat.type }, { upsert: true });
    } else {
      await Chat.deleteOne({ chat_id: chat.id.toString() });
    }
  } catch (e) {}
});

bot.on('inline_query', async (ctx) => {
  try {
    const query = ctx.inlineQuery.query;
    let questions = await Question.find(query ? { question: { $regex: query, $options: 'i' } } : {}).sort({ created_at: -1 }).limit(10);
    const results = questions.map(q => ({
      type: 'article', id: q._id.toString(), title: q.question,
      input_message_content: { message_text: `❓ *PSC Question*\n\n${q.question}\n\n1️⃣ ${q.options[0]}\n2️⃣ ${q.options[1]}\n3️⃣ ${q.options[2]}\n4️⃣ ${q.options[3]}`, parse_mode: 'Markdown' },
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('1', `vote_${q._id}_0`), Markup.button.callback('2', `vote_${q._id}_1`), Markup.button.callback('3', `vote_${q._id}_2`), Markup.button.callback('4', `vote_${q._id}_3`)]]).reply_markup
    }));
    return ctx.answerInlineQuery(results, { cache_time: 0 });
  } catch (e) { return ctx.answerInlineQuery([]); }
});

bot.action(/^vote_(.+)_(.+)$/, async (ctx) => {
  try {
    const qId = ctx.match[1];
    const selectedIndex = parseInt(ctx.match[2]);
    const q = await Question.findById(qId);
    if (!q) return ctx.answerCbQuery('Question not found.');
    if (selectedIndex === q.correct_option_index) await ctx.answerCbQuery(`✅ Correct!`, { show_alert: true });
    else await ctx.answerCbQuery(`❌ Wrong! Correct was: ${q.options[q.correct_option_index]}`, { show_alert: true });
  } catch (e) {}
});

bot.command(['postnow', 'gen'], async (ctx) => { await postToAllChats(); });

bot.command('users', async (ctx) => {
  const adminId = process.env.FORWARD_SOURCE_ID;
  if (ctx.from.id.toString() !== adminId) {
    return ctx.reply("❌ This command is only for the bot admin.");
  }

  try {
    const chats = await Chat.find();
    if (chats.length === 0) return ctx.reply("No chats registered.");

    let response = `📊 *Registered Bot Users*\n\nTotal: ${chats.length}\n\n`;
    
    chats.forEach((c, i) => {
      response += `${i + 1}. *${c.title}*\n   ID: \`${c.chat_id}\`\n   Type: ${c.type}\n   Link: ${c.invite_link || "N/A"}\n\n`;
      
      // Send in chunks to avoid length limits
      if ((i + 1) % 15 === 0) {
        ctx.replyWithMarkdown(response);
        response = "";
      }
    });

    if (response) ctx.replyWithMarkdown(response);
  } catch (err) {
    console.error("Users Command Error:", err.message);
  }
});

bot.command('stop', async (ctx) => { await State.deleteOne({ key: `marathon_${ctx.chat.id}` }); ctx.reply('🛑 Marathon stopped.'); });

bot.command('quiz', async (ctx) => {
  try {
    const q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    if (q) {
      await State.updateOne({ key: `marathon_${ctx.chat.id}` }, { value: { count: 0, target: 50 } }, { upsert: true });
      await ctx.sendPoll(q.question, q.options, { 
        type: 'quiz', 
        correct_option_id: q.correct_option_index, 
        is_anonymous: true
      });
    }
  } catch (e) {}
});

bot.on('poll', async (ctx) => {
  try {
    const poll = ctx.poll;
    if (!poll || poll.total_voter_count === 0) return;
    const pollState = await State.findOne({ key: `poll_${poll.id}` });
    if (pollState && !pollState.value.voted) {
      await State.updateOne({ key: `poll_${poll.id}` }, { 'value.voted': true });
      const chat_id = pollState.value.chat_id;
      const marathon = await State.findOne({ key: `marathon_${chat_id}` });
      if (marathon) {
        marathon.value.count++;
        if (marathon.value.count < marathon.value.target) {
          marathon.markModified('value'); await marathon.save();
          setTimeout(async () => {
            const q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
            if (q) {
              try {
                const msg = await bot.telegram.sendPoll(chat_id, q.question, q.options, { type: 'quiz', correct_option_id: q.correct_option_index, is_anonymous: true });
                await State.updateOne({ key: `poll_${msg.poll.id}` }, { value: { chat_id, voted: false } }, { upsert: true });
                q.is_posted = true; await q.save();
              } catch (err) { await handleMigration(err, chat_id); }
            }
          }, 3000);
        } else {
          await bot.telegram.sendMessage(chat_id, "🎉 Marathon complete!");
          await State.deleteOne({ key: `marathon_${chat_id}` });
        }
      }
    }
  } catch (e) { console.error("Poll Handler Error:", e.message); }
});

async function init() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
    bot.launch();
    console.log('✅ Bot is running and crash-proofed.');
    await postToAllChats(); // Drop 1st poll now
    generateQuestions('SSLC Level', 'General Knowledge', 20);
    
    // Countdown Timer Display
    setInterval(() => {
      minutesUntilNextPost--;
      if (minutesUntilNextPost <= 0) {
        postToAllChats();
      } else {
        console.log(`⏱️ Next poll in ${minutesUntilNextPost} minutes...`);
      }
    }, 60000); // Update every minute

    cron.schedule('0 * * * *', () => { generateQuestions(LEVELS[0], TOPICS[0], 50); });
  } catch (err) { console.error('Startup Error:', err); }
}

init();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
