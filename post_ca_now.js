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

  const caCycleState = {
    pendingIds: [],
    usedIds: []
  };

  function shuffleArray(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function getNextCaSelection() {
    if (caCycleState.pendingIds.length === 0) {
      if (caCycleState.usedIds.length > 0) {
        console.log('🔄 Reusing CA cycle in random order.');
        caCycleState.pendingIds = shuffleArray(caCycleState.usedIds);
        caCycleState.usedIds = [];
      } else {
        const docs = await CurrentAffairs.find({ questions: { $elemMatch: { isPosted: { $ne: true } } } }).sort({ date: 1 });
        if (!docs || docs.length === 0) {
          console.log('🔄 CA cycle exhausted. Resetting posted flags and starting again.');
          await CurrentAffairs.updateMany({}, { $set: { 'questions.$[].isPosted': false } });
          const resetDocs = await CurrentAffairs.find({ questions: { $elemMatch: { isPosted: { $ne: true } } } }).sort({ date: 1 });
          if (!resetDocs || resetDocs.length === 0) {
            return null;
          }
          caCycleState.pendingIds = shuffleArray(resetDocs.map(doc => doc._id.toString()));
        } else {
          caCycleState.pendingIds = shuffleArray(docs.map(doc => doc._id.toString()));
        }
      }
    }

    while (caCycleState.pendingIds.length > 0) {
      const nextId = caCycleState.pendingIds.shift();
      if (!nextId) continue;

      const doc = await CurrentAffairs.findById(nextId);
      if (!doc) continue;

      const pendingIndex = doc.questions.findIndex(entry => entry.isPosted !== true);
      if (pendingIndex === -1) continue;

      const candidate = doc.questions[pendingIndex];
      const rawOptions = [
        { key: 'A', value: candidate?.options?.A },
        { key: 'B', value: candidate?.options?.B },
        { key: 'C', value: candidate?.options?.C },
        { key: 'D', value: candidate?.options?.D }
      ].filter(o => Boolean(o.value));
      const correctOptionIndex = rawOptions.findIndex(o => o.key === candidate?.correctAnswer || o.value === candidate?.correctAnswer);
      const hasValidQuestion = typeof candidate?.question === 'string' && candidate.question.trim().length > 0 && rawOptions.length >= 2 && correctOptionIndex !== -1;

      if (!hasValidQuestion) {
        console.warn(`Skipping malformed CA question in ${doc.date || doc._id} because it is missing text, options, or a valid answer.`);
        await CurrentAffairs.updateOne(
          { _id: doc._id },
          { $set: { [`questions.${pendingIndex}.isPosted`]: true } }
        );
        continue;
      }

      caCycleState.usedIds.push(doc._id.toString());
      return { caDoc: doc, q: candidate, qIndex: pendingIndex };
    }

    if (caCycleState.usedIds.length > 0) {
      caCycleState.pendingIds = shuffleArray(caCycleState.usedIds);
      caCycleState.usedIds = [];
      return getNextCaSelection();
    }

    console.log('🔄 CA cycle exhausted. Resetting posted flags and starting again.');
    await CurrentAffairs.updateMany({}, { $set: { 'questions.$[].isPosted': false } });
    caCycleState.pendingIds = [];
    caCycleState.usedIds = [];
    return getNextCaSelection();
  }

  const selection = await getNextCaSelection();
  if (!selection) {
    console.log('⚠️ No more CA available in DB.');
    return { posted: false, reason: 'no_more_ca' };
  }

  const { caDoc, q, qIndex } = selection;

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
  return { posted: true, reason: 'posted' };
}

(async () => {
  try {
    console.log('📤 Posting CA question...');
    await connectDB();
    await postPollCA();
    process.exit(0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('❌ CA post failed:', message);
    process.exit(1);
  }
})();
