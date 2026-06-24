require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';

/**
 * post_ca_now.js
 * Manually triggers a CA poll post — same as /postnowca bot command.
 * Usage: node post_ca_now.js
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

async function postPollCA() {
  const CurrentAffairs = require('./models/CurrentAffairs');

  let caDoc = await CurrentAffairs.findOne({
    questions: { $elemMatch: { isPosted: { $ne: true } } }
  }).sort({ date: 1 });

  if (!caDoc) {
    console.log('⚠️  Skip: No unposted CA questions available.');
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
  const correct_option_index = rawOptions.findIndex(
    o => o.key === q.correctAnswer || o.value === q.correctAnswer
  );
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
    // ✅ Post as quiz poll
    await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, options, {
      type: 'quiz',
      correct_option_id: correct_option_index,
      is_anonymous: true,
      explanation: explanationText
    });
    console.log('✅ CA Poll posted successfully!');
  } else {
    // ⚠️ Fallback: too long for poll — send as text message
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
    console.log('✅ CA Text Message posted (question was too long for poll).');
  }

  await CurrentAffairs.updateOne(
    { _id: caDoc._id },
    { $set: { [`questions.${qIndex}.isPosted`]: true } }
  );
  console.log(`   Question: "${q.question.substring(0, 60)}..."`);
  console.log(`   Date: ${caDoc.dateDisplay || caDoc.date}`);
}

(async () => {
  try {
    console.log('📤 Posting CA question...');
    await connectDB();
    await postPollCA();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
