require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const cron = require('node-cron');

// --- Configuration ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

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

const Chat = mongoose.model('Chat', ChatSchema);
const State = mongoose.model('State', StateSchema);
const Question = require('./models/Question');
const CurrentAffairs = require('./models/CurrentAffairs');

// --- LLM Logic (Deprecated for now since we are moving to CA) ---
async function generateQuestions(level, topic, count = 10) {
  return [];
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

    let q = await Question.findOne({ isPosted: { $ne: true } }).sort({ createdAt: 1 });
    if (!q) {
      console.log('Skip: No regular questions available.');
      return;
    }

    const rawOptions = [
      { key: 'A', value: q.options.A },
      { key: 'B', value: q.options.B },
      { key: 'C', value: q.options.C },
      { key: 'D', value: q.options.D }
    ].filter(o => Boolean(o.value));
    
    const options = rawOptions.map(o => o.value);
    const correct_option_index = rawOptions.findIndex(o => o.key === q.correctAnswer || o.value === q.correctAnswer);

    await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, options, {
      type: 'quiz',
      correct_option_id: correct_option_index,
      is_anonymous: true,
      explanation: `${q.explanation || ''}\n\nJoin our channel for more: ${CHANNEL_LINK}`
    });

    await Question.updateOne({ _id: q._id }, { $set: { isPosted: true } });
    console.log(`Regular Poll posted directly to ${TARGET_CHANNEL_ID}`);
  } catch (err) {
    console.error('Post Error:', err.message);
  }
}

async function postPollCA() {
  try {
    await connectDB();

    // Find the oldest CA document that has an unposted question
    let caDoc = await CurrentAffairs.findOne({ questions: { $elemMatch: { isPosted: { $ne: true } } } }).sort({ date: 1 });

    if (!caDoc) {
      console.log('Skip: No CA questions available.');
      return;
    }

    const qIndex = caDoc.questions.findIndex(q => q.isPosted !== true);
    if (qIndex === -1) return;
    const q = caDoc.questions[qIndex];

    const rawOptions = [
      { key: 'A', value: q.options.A },
      { key: 'B', value: q.options.B },
      { key: 'C', value: q.options.C },
      { key: 'D', value: q.options.D }
    ].filter(o => Boolean(o.value));
    
    const options = rawOptions.map(o => o.value);
    const correct_option_index = rawOptions.findIndex(o => o.key === q.correctAnswer || o.value === q.correctAnswer);
    const dateLabel = `📅 Date: ${caDoc.dateDisplay || caDoc.date}`;
    const channelSuffix = `\n\nJoin: ${CHANNEL_LINK}`;
    const suffix = `\n\n${dateLabel}${channelSuffix}`;
    // Telegram poll explanation max is 200 chars
    const maxExp = 200 - suffix.length;
    const trimmedExp = (q.explanation || '').length > maxExp
      ? (q.explanation || '').substring(0, maxExp - 1) + '…'
      : (q.explanation || '');
    const explanationText = trimmedExp ? `${trimmedExp}${suffix}` : `${dateLabel}${channelSuffix}`;

    if (q.question.length <= 295) {
      // ✅ Normal path: post as poll
      await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, options, {
        type: 'quiz',
        correct_option_id: correct_option_index,
        is_anonymous: true,
        explanation: explanationText
      });
      console.log(`CA Poll posted to ${TARGET_CHANNEL_ID}`);
    } else {
      // ⚠️ Fallback: question too long for poll — send as formatted text message
      const optionLines = rawOptions.map(o => `  <b>${o.key}.</b> ${o.value}`).join('\n');
      const correctOption = rawOptions.find(o => o.key === q.correctAnswer || o.value === q.correctAnswer);
      const correctLabel = correctOption ? `${correctOption.key}. ${correctOption.value}` : q.correctAnswer;

      let textMsg = `🗞️ <b>Current Affairs Quiz</b>\n`;
      textMsg += `${dateLabel}\n\n`;
      textMsg += `❓ ${q.question}\n\n`;
      textMsg += `${optionLines}\n\n`;
      textMsg += `✅ <b>Answer:</b> <tg-spoiler>${correctLabel}</tg-spoiler>`;
      if (q.explanation) {
        textMsg += `\n\n💡 <b>Explanation:</b> ${q.explanation}`;
      }
      textMsg += `\n\n🔗 ${CHANNEL_LINK}`;

      await bot.telegram.sendMessage(TARGET_CHANNEL_ID, textMsg, { parse_mode: 'HTML' });
      console.log(`CA Text Message posted to ${TARGET_CHANNEL_ID} (question too long for poll)`);
    }

    await CurrentAffairs.updateOne(
      { _id: caDoc._id },
      { $set: { [`questions.${qIndex}.isPosted`]: true } }
    );
  } catch (err) {
    console.error('Post CA Error:', err.message);
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
    postPollCA();
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
  await ctx.reply('✅ Regular Poll posted manually.');
});

bot.command('postnowca', adminOnly, async (ctx) => {
  await postPollCA();
  await ctx.reply('✅ CA Poll posted manually.');
});

bot.command('reset', adminOnly, async (ctx) => {
  await connectDB();
  const result = await CurrentAffairs.updateMany({}, { $set: { 'questions.$[].isPosted': false } });
  ctx.reply(`✅ Reset questions.`);
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
  ctx.reply(`Cleanup command is deprecated for CA flow.`);
});

// Admin upload state
const adminFlowState = {};

bot.command('upload_ca', adminOnly, async (ctx) => {
  adminFlowState[ctx.from.id] = { step: 'date' };
  await ctx.reply('Enter the CA Date (YYYY-MM-DD):');
});

// --- Admin Direct Post ---
bot.on('message', async (ctx, next) => {
  const adminId = process.env.ADMIN;
  if (ctx.chat.type === 'private' && ctx.from.id.toString() === adminId) {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) {
      return next(); 
    }
    
    const state = adminFlowState[ctx.from.id];
    if (state) {
      if (state.step === 'date') {
        state.date = text;
        state.step = 'question';
        await ctx.reply('Enter the Question:');
      } else if (state.step === 'question') {
        state.question = text;
        state.step = 'optA';
        await ctx.reply('Enter Option A:');
      } else if (state.step === 'optA') {
        state.options = { A: text };
        state.step = 'optB';
        await ctx.reply('Enter Option B:');
      } else if (state.step === 'optB') {
        state.options.B = text;
        state.step = 'optC';
        await ctx.reply('Enter Option C:');
      } else if (state.step === 'optC') {
        state.options.C = text;
        state.step = 'optD';
        await ctx.reply('Enter Option D:');
      } else if (state.step === 'optD') {
        state.options.D = text;
        state.step = 'correct';
        await ctx.reply('Enter Correct Answer (A/B/C/D):');
      } else if (state.step === 'correct') {
        state.correctAnswer = text.toUpperCase();
        state.step = 'exp';
        await ctx.reply('Enter Explanation (or type "skip"):');
      } else if (state.step === 'exp') {
        state.explanation = text.toLowerCase() === 'skip' ? '' : text;
        
        // Save to DB
        try {
          await connectDB();
          let caDoc = await CurrentAffairs.findOne({ date: state.date });
          if (!caDoc) {
             caDoc = new CurrentAffairs({ date: state.date, dateDisplay: state.date, questions: [] });
          }
          caDoc.questions.push({
             question: state.question,
             options: state.options,
             correctAnswer: state.correctAnswer,
             explanation: state.explanation,
             isPosted: false
          });
          await caDoc.save();
          await ctx.reply('✅ CA Question saved successfully!');
        } catch (err) {
          await ctx.reply('❌ Error saving: ' + err.message);
        }
        delete adminFlowState[ctx.from.id];
      }
      return;
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

// --- Quiz Marathon Logic ---
const activeQuizzes = {}; // track in-memory: { chatId: { score: 0, count: 0, target: 50, userId: starterUserId, username: starterUsername, currentPollId: null, correctOptionIndex: 0 } }

bot.command('quiz', async (ctx) => {
  // Only allow in PM or groups where polls can be non-anonymous. Channels won't work.
  if (ctx.chat.type === 'channel') {
    return ctx.reply('❌ The /quiz command only works in private chats or groups.');
  }
  
  const key = `${ctx.chat.id}`;
  if (activeQuizzes[key]) {
    return ctx.reply('❌ A quiz is already active in this chat! Please answer the current question.');
  }

  activeQuizzes[key] = {
    score: 0,
    count: 0,
    target: 50,
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    currentPollId: null,
    correctOptionIndex: 0
  };

  await sendNextQuizQuestion(key);
});

bot.command('end', async (ctx) => {
  const key = `${ctx.chat.id}`;
  const session = activeQuizzes[key];
  if (!session) {
    return ctx.reply('❌ There is no active quiz in this chat to end.');
  }

  const mention = session.username ? `@${session.username}` : `<a href="tg://user?id=${session.userId}">${session.first_name || 'User'}</a>`;
  await ctx.reply(`🛑 Quiz Ended Early!\n\nStarted by: ${mention}\nGroup Score: ${session.score} / ${session.count}`, { parse_mode: 'HTML' });
  delete activeQuizzes[key];
});

async function sendNextQuizQuestion(key) {
  const session = activeQuizzes[key];
  if (!session) return;

  if (session.count >= session.target) {
    // Finish Quiz
    const mention = session.username ? `@${session.username}` : `<a href="tg://user?id=${session.userId}">${session.first_name || 'User'}</a>`;
    await bot.telegram.sendMessage(session.chatId, `🎉 Quiz Finished!\n\nStarted by: ${mention}\nGroup Score: ${session.score} / ${session.target}`, { parse_mode: 'HTML' });
    delete activeQuizzes[key];
    return;
  }

  try {
    await connectDB();
    
    // Pick a random question for the quiz
    const count = await Question.countDocuments({});
    const random = Math.floor(Math.random() * count);
    const q = await Question.findOne().skip(random);

    if (!q) {
      await bot.telegram.sendMessage(session.chatId, `❌ Out of questions in the database.`);
      delete activeQuizzes[key];
      return;
    }

    const rawOptions = [
      { key: 'A', value: q.options.A },
      { key: 'B', value: q.options.B },
      { key: 'C', value: q.options.C },
      { key: 'D', value: q.options.D }
    ].filter(o => Boolean(o.value));
    
    const options = rawOptions.map(o => o.value);
    const correct_option_index = rawOptions.findIndex(o => o.key === q.correctAnswer || o.value === q.correctAnswer);

    if (correct_option_index === -1) {
      console.warn(`Skipping Quiz question ${q._id} because it has an invalid correctAnswer: ${q.correctAnswer}`);
      return sendNextQuizQuestion(key);
    }

    const msg = await bot.telegram.sendPoll(session.chatId, `(Q${session.count + 1}/${session.target}) ${q.question}`, options, {
      type: 'quiz',
      correct_option_id: correct_option_index,
      is_anonymous: false, // Must be non-anonymous to track user's answer
      explanation: q.explanation || 'No explanation available.'
    });

    session.currentPollId = msg.poll.id;
    session.correctOptionIndex = correct_option_index;
    
  } catch (err) {
    console.error('Quiz send error:', err.message);
    delete activeQuizzes[key];
  }
}

bot.on('poll_answer', async (ctx) => {
  const answer = ctx.pollAnswer;
  const pollId = answer.poll_id;
  
  // Find the active quiz session matching this poll
  let activeSessionKey = null;
  for (const [key, session] of Object.entries(activeQuizzes)) {
    if (session.currentPollId === pollId) {
      activeSessionKey = key;
      break;
    }
  }

  if (activeSessionKey) {
    const session = activeQuizzes[activeSessionKey];
    const selectedOption = answer.option_ids[0];
    
    // Lock by resetting currentPollId immediately to prevent duplicate triggers
    session.currentPollId = null;

    if (selectedOption === session.correctOptionIndex) {
      session.score += 1;
    }
    
    session.count += 1;
    
    // Slight delay before sending the next question
    setTimeout(() => {
      sendNextQuizQuestion(activeSessionKey);
    }, 1500);
  }
});

// --- Vercel Serverless Export ---
module.exports = async (req, res) => {
  await connectDB();

  if (req.url === '/api/cron') {
    await postPoll();
    return res.status(200).send('Cron Job Executed');
  }

  if (req.url === '/api/cron-ca') {
    await postPollCA();
    return res.status(200).send('CA Cron Job Executed');
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
  
  if (args.includes('--cron-ca')) {
    console.log('Running scheduled CA poll post...');
    await postPollCA();
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
      
      // Post CA poll every 30 minutes (no daily limit)
      cron.schedule('*/30 * * * *', () => {
        console.log('Running 30-minute scheduled CA poll post...');
        postPollCA();
      });
      
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
