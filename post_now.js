require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';

/**
 * post_now.js
 * Manually triggers a regular question poll — same as /postnow bot command.
 * If all questions are exhausted, auto-resets and picks the oldest one.
 * Usage: node post_now.js
 */

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');

const TARGET_CHANNEL_ID = '-1003944522871';
const CHANNEL_LINK = 'https://t.me/kerala_psc_study';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
  console.log('✅ Connected to MongoDB');
}

async function postNow() {
  const Question = require('./models/Question');

  let q = await Question.findOne({ isPosted: { $ne: true } }).sort({ createdAt: 1 });

  if (!q) {
    // All questions posted — reset and recycle
    const total = await Question.countDocuments({});
    if (total === 0) {
      console.log('❌ No questions in the database at all.');
      return;
    }
    console.log(`⚠️  All ${total} questions have been posted. Resetting isPosted flags...`);
    await Question.updateMany({}, { $set: { isPosted: false } });
    q = await Question.findOne({ isPosted: { $ne: true } }).sort({ createdAt: 1 });
    console.log('🔄 Reset done. Picking from the start again.');
  }

  const rawOptions = [
    { key: 'A', value: q.options.A },
    { key: 'B', value: q.options.B },
    { key: 'C', value: q.options.C },
    { key: 'D', value: q.options.D }
  ].filter(o => Boolean(o.value));

  const options = rawOptions.map(o => o.value);
  const correct_option_index = rawOptions.findIndex(
    o => o.key === q.correctAnswer || o.value === q.correctAnswer
  );

  if (correct_option_index === -1) {
    console.log(`❌ Invalid correctAnswer "${q.correctAnswer}" for question: ${q._id}`);
    return;
  }

  // Build explanation — Telegram poll explanation max is 200 chars
  const channelSuffix = `\n\nJoin: ${CHANNEL_LINK}`;
  const suffix = channelSuffix;
  const maxExp = 200 - suffix.length;
  const trimmedExp = (q.explanation || '').length > maxExp
    ? (q.explanation || '').substring(0, maxExp - 1) + '…'
    : (q.explanation || '');
  const explanationText = (trimmedExp ? trimmedExp : 'No explanation.') + suffix;

  await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, options, {
    type: 'quiz',
    correct_option_id: correct_option_index,
    is_anonymous: true,
    explanation: explanationText
  });

  await Question.updateOne({ _id: q._id }, { $set: { isPosted: true } });

  console.log('✅ Poll posted successfully!');
  console.log(`   Question: "${q.question.substring(0, 70)}${q.question.length > 70 ? '...' : ''}"`);
  console.log(`   Level: ${q.level} | Category: ${q.category}`);
}

(async () => {
  try {
    console.log('📤 Posting regular question poll...');
    await connectDB();
    await postNow();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
