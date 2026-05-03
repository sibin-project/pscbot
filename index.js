require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenAI } = require('@google/genai');
const cron = require('node-cron');

// --- Configuration ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TOPICS = [
  'General Knowledge',
  'Current Affairs',
  'Mathematics',
  'English Grammar',
  'Malayalam',
  'General Science',
  'Indian Constitution'
];
const LEVELS = ['SSLC Level', 'Plus Two Level', 'Degree Level'];
const MODEL_NAME = 'gemini-3-flash-preview';
const TARGET_CHANNEL_ID = '-1003944522871';
const CHANNEL_LINK = 'https://t.me/kerala_psc_study';

// --- Database Connection ---
let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, { 
      family: 4,
      serverSelectionTimeoutMS: 10000, // 10s timeout
    });
    isConnected = true;
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    // Don't set isConnected to true, so it can retry later
    throw err;
  }
}

// --- Global Error Handler ---
bot.catch((err, ctx) => {
  console.error('Global Bot Error:', err.message);
});

// --- MongoDB Models ---
const QuestionSchema = new mongoose.Schema({
  question: { type: String, unique: true, required: true },
  options: { type: [String], required: true },
  explanation: { type: String, required: true },
  correct_option_index: { type: Number, required: true },
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
    const prompt = `Generate ${count} unique Kerala PSC questions in JSON format. Each question object MUST have:
    - "question": The question text
    - "options": Array of 4 strings
    - "correct_option_index": Number (0-3)
    - "explanation": A brief explanation (max 150 chars)
    Level: ${level}, Topic: ${topic}. History: [${history}]`;

    const response = await ai.models.generateContent({ model: MODEL_NAME, contents: prompt });
    const text = response.text;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']') + 1;
    if (start === -1) return [];

    const questions = JSON.parse(text.substring(start, end));
    for (const q of questions) {
      try {
        await Question.create(q);
      } catch (e) {}
    }

    await State.updateOne(
      { key: 'history' },
      { value: [...(historyState?.value || []), ...questions.map((q) => q.question)].slice(-50) },
      { upsert: true }
    );

    return questions;
  } catch (err) {
    if (err.message.includes('quota') || err.message.includes('429')) {
      await State.updateOne(
        { key: 'rate_limit_pause' },
        { value: { paused_until: Date.now() + 60 * 60 * 1000 } },
        { upsert: true }
      );
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
async function postPoll() {
  try {
    await connectDB();
    let q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    if (!q) {
      console.log('Out of questions. Attempting to generate more...');
      await generateQuestions(LEVELS[0], TOPICS[0], 5);
      q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    }

    if (!q) {
      console.log('Still no questions available. Resetting history...');
      await Question.updateMany({}, { is_posted: false });
      q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
    }

    if (!q) {
      console.log('Skip: No questions available.');
      return;
    }

    await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, q.options, {
      type: 'quiz',
      correct_option_id: q.correct_option_index,
      is_anonymous: true,
      explanation: `${q.explanation}\n\nJoin our channel for more: ${CHANNEL_LINK}`
    });

    q.is_posted = true;
    await q.save();
    console.log(`Poll posted directly to ${TARGET_CHANNEL_ID}`);
  } catch (err) {
    console.error('Post Error:', err.message);
  }
}

function getNextPollTime() {
  const now = new Date();
  const times = [
    { h: 8, m: 0 },
    { h: 13, m: 30 },
    { h: 20, m: 0 }
  ];
  
  for (const t of times) {
    const pollDate = new Date();
    pollDate.setHours(t.h, t.m, 0, 0);
    if (pollDate > now) return pollDate.toLocaleTimeString();
  }
  
  // If all today's times passed, return 8 AM tomorrow
  return 'Tomorrow 08:00 AM';
}

function logStatus() {
  console.log(`[STATUS] Last Active: ${new Date().toLocaleString()}`);
  console.log(`[STATUS] Next Poll Drop Time: ${getNextPollTime()}`);
}

function scheduleWindowPosts(durationMinutes) {
  const half = durationMinutes / 2;
  const delay1 = Math.floor(Math.random() * (half - 5)) * 60 * 1000;
  const delay2 = Math.floor(half + Math.random() * (half - 5)) * 60 * 1000;
  
  logStatus();
  console.log(`Scheduling 2 polls in the next ${durationMinutes} minutes.`);
  
  setTimeout(() => {
    console.log('Posting scheduled poll (1/2)...');
    postPoll();
  }, delay1);
  
  setTimeout(() => {
    console.log('Posting scheduled poll (2/2)...');
    postPoll();
  }, delay2);
}

// --- Admin Middleware ---
const adminOnly = async (ctx, next) => {
  const adminId = process.env.ADMIN;
  if (ctx.from && ctx.from.id.toString() === adminId) {
    return next();
  }
  // No action for non-admins
};

// --- Handlers ---
bot.start(adminOnly, async (ctx) => {
  await connectDB();
  await Chat.updateOne(
    { chat_id: ctx.chat.id.toString() },
    { title: ctx.chat.title || 'User', type: ctx.chat.type },
    { upsert: true }
  );
  await ctx.reply('Welcome! Kerala PSC questions will be posted here according to the schedule.');
});

bot.on('my_chat_member', async (ctx) => {
  await connectDB();
  const chat = ctx.myChatMember.chat;
  const status = ctx.myChatMember.new_chat_member.status;
  if (status === 'administrator' || status === 'member') {
    await Chat.updateOne(
      { chat_id: chat.id.toString() },
      { title: chat.title || 'Unknown', type: chat.type },
      { upsert: true }
    );
  } else {
    await Chat.deleteOne({ chat_id: chat.id.toString() });
  }
});

bot.help(adminOnly, async (ctx) => {
  let helpText = `*📚 Kerala PSC Bot Help*\n\n`;
  helpText += `*Admin Commands:*\n`;
  helpText += `• /postnow - Manually post a poll to the channel\n`;
  helpText += `• /reset - Reset question history (re-post old questions)\n`;
  helpText += `• /users - List all groups where bot is active\n`;
  helpText += `• /cleanup - Remove invalid questions from database\n`;
  helpText += `• /gen - Same as /postnow\n\n`;
  helpText += `*Direct Posting:*\n`;
  helpText += `Just send any message to the bot in PM to post it directly to the channel.\n`;

  await ctx.replyWithMarkdown(helpText);
});


bot.command(['postnow', 'gen'], adminOnly, async (ctx) => {
  await postPoll();
  await ctx.reply('✅ Poll posted manually.');
});

bot.command('reset', adminOnly, async (ctx) => {
  await connectDB();
  const result = await Question.updateMany({}, { is_posted: false });
  ctx.reply(`✅ Reset ${result.modifiedCount} questions. They can now be posted again.`);
});

bot.command('users', adminOnly, async (ctx) => {
  await connectDB();
  const chats = await Chat.find();
  let response = `Registered Users: ${chats.length}\n\n`;
  chats.forEach((c, i) => {
    response += `${i + 1}. ${c.title} (${c.type})\n`;
  });
  ctx.replyWithMarkdown(response);
});

bot.command('cleanup', adminOnly, async (ctx) => {
  await connectDB();
  const result = await Question.deleteMany({
    $or: [
      { question: { $exists: false } },
      { question: "" },
      { options: { $exists: false } },
      { options: { $size: 0 } },
      { explanation: { $exists: false } },
      { explanation: "" },
      { correct_option_index: { $exists: false } }
    ]
  });
  ctx.reply(`✅ Cleaned up ${result.deletedCount} invalid question sets.`);
});

// --- Admin Direct Post ---
bot.on('message', async (ctx, next) => {
  const adminId = process.env.ADMIN;
  // If admin sends something in PM and it's not a command
  if (ctx.chat.type === 'private' && ctx.from.id.toString() === adminId) {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) {
      return next(); // Let commands be handled by command handlers
    }
    
    try {
      await bot.telegram.copyMessage(TARGET_CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
      await ctx.reply('✅ Posted to channel.');
    } catch (err) {
      await ctx.reply(`❌ Error posting to channel: ${err.message}`);
    }
    return;
  }
  return next();
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
      marathon.value.count++;
      marathon.markModified('value');
      await marathon.save();

      setTimeout(async () => {
        let q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
        if (!q) {
          console.log('Marathon out of fresh questions. Resetting history...');
          await Question.updateMany({}, { is_posted: false });
          q = await Question.findOne({ is_posted: false }).sort({ created_at: 1 });
        }

        if (q) {
          const msg = await bot.telegram.sendPoll(pollState.value.chat_id, q.question, q.options, {
            type: 'quiz',
            correct_option_id: q.correct_option_index,
            is_anonymous: true,
            explanation: `${q.explanation}\n\nJoin our channel for more: ${CHANNEL_LINK}`
          });

          await State.updateOne(
            { key: `poll_${msg.poll.id}` },
            { value: { chat_id: pollState.value.chat_id, voted: false } },
            { upsert: true }
          );

          q.is_posted = true;
          await q.save();
        }
      }, 3000);
    }
  }
});

// --- Vercel Serverless Export ---
module.exports = async (req, res) => {
  await connectDB();

  if (req.url === '/api/cron') {
    await postPoll();
    return res.status(200).send('Cron Job Executed');
  }

  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  res.status(200).send('Bot is online!');
};

// --- execution Logic for GitHub Actions / On-Demand ---
async function runOnce() {
  const args = process.argv;
  
  if (args.includes('--cron')) {
    logStatus();
    console.log('Running scheduled poll post...');
    await postPoll();
    process.exit(0);
  }
  
  if (args.includes('--gen')) {
    console.log('Running question generation...');
    await generateQuestions(LEVELS[0], TOPICS[0], 50);
    process.exit(0);
  }
}

// --- Koyeb / Local / GitHub Actions Persistent Server ---
if (!process.env.VERCEL) {
  runOnce().then(() => {
    // If runOnce didn't exit, start the server/bot normally
    const express = require('express');
    const app = express();

    app.get('/', (req, res) => res.send('Bot is running!'));

    const preferredPort = Number(process.env.PORT) || 8000;
    const hasFixedPort = Boolean(process.env.PORT);

    function startHealthServer(port) {
      const server = app.listen(port, () => {
        const actualPort = server.address().port;
        console.log(`Health check server on port ${actualPort}`);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !hasFixedPort && port === preferredPort) {
          console.warn(`Port ${preferredPort} is already in use. Retrying on a random open port...`);
          setImmediate(() => startHealthServer(0));
          return;
        }
        throw err;
      });

      return server;
    }

    startHealthServer(preferredPort);

    connectDB().then(() => {
      logStatus();
      bot.launch();
      console.log('Bot is running in interactive mode');

      // Internal cron (only if running persistently)
      cron.schedule('0 8 * * *', () => scheduleWindowPosts(60));
      cron.schedule('30 13 * * *', () => scheduleWindowPosts(60));
      cron.schedule('0 20 * * *', () => scheduleWindowPosts(60));
      cron.schedule('0 * * * *', () => generateQuestions(LEVELS[0], TOPICS[0], 50));
      
      // Auto-exit after 15 minutes if running in a CI environment (like GitHub Actions)
      if (process.env.GITHUB_ACTIONS) {
        console.log('GitHub Actions detected. Bot will auto-shutdown in 15 minutes to save minutes.');
        setTimeout(() => {
          console.log('Auto-shutdown timer reached. Exiting...');
          process.exit(0);
        }, 15 * 60 * 1000);
      }
    });
  });
}
