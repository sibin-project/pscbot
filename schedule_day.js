require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';

/**
 * schedule_day.js
 *
 * Posts 6 polls per day between 9am and 11pm:
 * - 3 normal MCQ questions (from Question model)
 * - 3 CA questions (from CurrentAffairs model)
 * CA messages include -ca-{date} tag.
 *
 * Usage: node schedule_day.js
 */

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const Question = require('./models/Question');
const CurrentAffairs = require('./models/CurrentAffairs');

const TARGET_CHANNEL_ID = '-1003944522871';
const CHANNEL_LINK = 'https://t.me/kerala_psc_study';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Post schedule: 6 posts between 9am and 11pm (14 hours)
// Spaced evenly every ~2h 20min
const POST_SCHEDULE = [
  { hour: 9, minute: 0 },
  { hour: 11, minute: 20 },
  { hour: 13, minute: 40 },
  { hour: 16, minute: 0 },
  { hour: 18, minute: 20 },
  { hour: 20, minute: 40 }
];

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
  console.log('✅ Connected to MongoDB');
}

async function postMCQQuestion() {
  try {
    const q = await Question.findOne({
      isPosted: { $ne: true },
      questionType: 'mcq'
    }).sort({ createdAt: 1 });

    if (!q) {
      console.log('⚠️ No more MCQ questions available.');
      return null;
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
      console.log(`❌ Invalid correctAnswer for question: ${q._id}`);
      return null;
    }

    const channelSuffix = `\n\nJoin: ${CHANNEL_LINK}`;
    const maxExp = 200 - channelSuffix.length;
    const trimmedExp = (q.explanation || '').length > maxExp
      ? (q.explanation || '').substring(0, maxExp - 1) + '…'
      : (q.explanation || '');
    const explanationText = (trimmedExp ? trimmedExp : 'No explanation.') + channelSuffix;

    await bot.telegram.sendPoll(TARGET_CHANNEL_ID, q.question, options, {
      type: 'quiz',
      correct_option_id: correct_option_index,
      is_anonymous: true,
      explanation: explanationText
    });

    await Question.updateOne({ _id: q._id }, { $set: { isPosted: true } });
    console.log(`✅ MCQ posted: "${q.question.substring(0, 50)}..."`);
    return true;
  } catch (err) {
    console.error('❌ MCQ post failed:', err.message);
    return null;
  }
}

async function postCAQuestion() {
  try {
    const caDoc = await CurrentAffairs.findOne({
      'questions.isPosted': { $ne: true }
    }).sort({ date: 1 });

    if (!caDoc || !caDoc.questions || caDoc.questions.length === 0) {
      console.log('⚠️ No more CA questions available.');
      return null;
    }

    const pendingQuestion = caDoc.questions.find(q => q.isPosted !== true);
    if (!pendingQuestion) {
      console.log('⚠️ No pending questions in this CA document.');
      return null;
    }

    const rawOptions = [
      { key: 'A', value: pendingQuestion.options?.A },
      { key: 'B', value: pendingQuestion.options?.B },
      { key: 'C', value: pendingQuestion.options?.C },
      { key: 'D', value: pendingQuestion.options?.D }
    ].filter(o => Boolean(o.value));

    const options = rawOptions.map(o => o.value);
    const correct_option_index = rawOptions.findIndex(
      o => o.key === pendingQuestion.correctAnswer || o.value === pendingQuestion.correctAnswer
    );

    const dateLabel = `📅 Date: ${caDoc.dateDisplay || caDoc.date}`;
    const caTag = `-ca-${caDoc.date}`;
    const channelSuffix = `\n\nJoin: ${CHANNEL_LINK}`;
    const suffix = `\n\n${dateLabel}${channelSuffix}`;
    const maxExp = 200 - suffix.length;
    const trimmedExp = (pendingQuestion.explanation || '').length > maxExp
      ? (pendingQuestion.explanation || '').substring(0, maxExp - 1) + '…'
      : (pendingQuestion.explanation || '');
    const explanationText = trimmedExp ? `${trimmedExp}${suffix}` : `${dateLabel}${channelSuffix}`;

    const questionText = pendingQuestion.question + ` ${caTag}`;

    if (questionText.length <= 295) {
      await bot.telegram.sendPoll(TARGET_CHANNEL_ID, questionText, options, {
        type: 'quiz',
        correct_option_id: correct_option_index,
        is_anonymous: true,
        explanation: explanationText
      });
    } else {
      const optionLines = rawOptions.map(o => `  <b>${o.key}.</b> ${o.value}`).join('\n');
      const correctOption = rawOptions.find(o => o.key === pendingQuestion.correctAnswer || o.value === pendingQuestion.correctAnswer);
      const correctLabel = correctOption ? `${correctOption.key}. ${correctOption.value}` : pendingQuestion.correctAnswer;

      let textMsg = `🗞️ <b>Current Affairs Quiz</b>\n`;
      textMsg += `${dateLabel}\n`;
      textMsg += `${caTag}\n\n`;
      textMsg += `❓ ${pendingQuestion.question}\n\n`;
      textMsg += `${optionLines}\n\n`;
      textMsg += `✅ <b>Answer:</b> <tg-spoiler>${correctLabel}</tg-spoiler>`;
      if (pendingQuestion.explanation) {
        textMsg += `\n\n💡 <b>Explanation:</b> ${pendingQuestion.explanation}`;
      }
      textMsg += `\n\n🔗 ${CHANNEL_LINK}`;

      await bot.telegram.sendMessage(TARGET_CHANNEL_ID, textMsg, { parse_mode: 'HTML' });
    }

    const pendingIndex = caDoc.questions.indexOf(pendingQuestion);
    await CurrentAffairs.updateOne(
      { _id: caDoc._id },
      { $set: { [`questions.${pendingIndex}.isPosted`]: true } }
    );
    console.log(`✅ CA posted: "${pendingQuestion.question.substring(0, 50)}..." ${caTag}`);
    return true;
  } catch (err) {
    console.error('❌ CA post failed:', err.message);
    return null;
  }
}

async function getMCQBatch(count) {
  const questions = await Question.find({
    isPosted: { $ne: true },
    questionType: 'mcq'
  }).sort({ createdAt: 1 }).limit(count);
  return questions;
}

async function getCABatch(count) {
  const docs = await CurrentAffairs.find({
    'questions.isPosted': { $ne: true }
  }).sort({ date: 1 }).limit(count);
  return docs;
}

async function schedulePosts() {
  try {
    await connectDB();

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeInMinutes = currentHour * 60 + currentMinute;
    const nineAM = 9 * 60;
    const elevenPM = 23 * 60;

    // Filter schedule to only future posts within 9am-11pm
    const pendingPosts = POST_SCHEDULE.filter(slot => {
      const slotTime = slot.hour * 60 + slot.minute;
      return slotTime >= currentTimeInMinutes && slotTime <= elevenPM;
    });

    if (pendingPosts.length === 0) {
      console.log('⚠️ All scheduled posts for today have passed. Tomorrow is a new day.');
      process.exit(0);
    }

    console.log(`📅 Scheduling ${pendingPosts.length} posts for today`);
    console.log(`📅 Current time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log(`📅 Posts remaining: ${pendingPosts.length}`);

    // Get 3 MCQ and 3 CA questions upfront
    const [mcqDocs, caDocs] = await Promise.all([
      getMCQBatch(3),
      getCABatch(3)
    ]);

    if (mcqDocs.length === 0) {
      console.log('⚠️ No MCQ questions available. Waiting for more...');
    }
    if (caDocs.length === 0) {
      console.log('⚠️ No CA questions available. Waiting for more...');
    }

    let mcqIndex = 0;
    let caIndex = 0;
    let postCount = 0;

    for (const slot of pendingPosts) {
      const slotTime = slot.hour * 60 + slot.minute;
      const delay = (slotTime - currentTimeInMinutes) * 60 * 1000;

      setTimeout(async () => {
        try {
          const now2 = new Date();
          const currentTime2 = now2.getHours() * 60 + now2.getMinutes();

          if (currentTime2 > elevenPM) {
            console.log('⏰ Past 11pm, skipping post.');
            return;
          }

          // Alternate: 3 MCQ first, then 3 CA, or mix them
          // For even distribution: MCQ, CA, MCQ, CA, MCQ, CA
          let result = null;
          if (postCount % 2 === 0 && mcqIndex < mcqDocs.length) {
            result = await postMCQQuestion();
            if (result) mcqIndex++;
          } else if (caIndex < caDocs.length) {
            result = await postCAQuestion();
            if (result) caIndex++;
          } else if (mcqIndex < mcqDocs.length) {
            result = await postMCQQuestion();
            if (result) mcqIndex++;
          } else if (caIndex < caDocs.length) {
            result = await postCAQuestion();
            if (result) caIndex++;
          }

          postCount++;
          console.log(`📊 Post ${postCount}/${pendingPosts.length} completed.`);
        } catch (err) {
          console.error('❌ Scheduled post failed:', err.message);
        }
      }, delay);
    }

    console.log(`✅ ${pendingPosts.length} posts scheduled. Waiting for delivery...`);
  } catch (err) {
    console.error('❌ Scheduling failed:', err.message);
    process.exit(1);
  }
}

schedulePosts();