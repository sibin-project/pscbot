require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';

/**
 * schedule_day.js
 *
 * Posts exactly 6 polls per day between 9am and 11pm:
 * - 3 normal MCQ questions (from Question model)
 * - 3 CA questions (from CurrentAffairs model)
 * CA messages include -ca-{date} tag.
 *
 * Spaced at 30-minute intervals:
 * 9:00, 9:30, 10:00, 10:30, 11:00, 11:30
 *
 * Usage: node schedule_day.js
 * Only posts quiz polls — no text message fallbacks.
 */

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const Question = require('./models/Question');
const CurrentAffairs = require('./models/CurrentAffairs');

const TARGET_CHANNEL_ID = '-1003944522871';
const CHANNEL_LINK = 'https://t.me/kerala_psc_study';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 6 posts at 30-min intervals: 9:00, 9:30, 10:00, 10:30, 11:00, 11:30
const POST_TIMES = [
  { hour: 9, minute: 0 },
  { hour: 9, minute: 30 },
  { hour: 10, minute: 0 },
  { hour: 10, minute: 30 },
  { hour: 11, minute: 0 },
  { hour: 11, minute: 30 }
];

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
  console.log('✅ Connected to MongoDB');
}

async function postMCQPoll(question) {
  const rawOptions = [
    { key: 'A', value: question.options.A },
    { key: 'B', value: question.options.B },
    { key: 'C', value: question.options.C },
    { key: 'D', value: question.options.D }
  ].filter(o => Boolean(o.value));

  const options = rawOptions.map(o => o.value);
  const correct_option_index = rawOptions.findIndex(
    o => o.key === question.correctAnswer || o.value === question.correctAnswer
  );

  if (correct_option_index === -1) {
    console.log(`❌ Invalid correctAnswer for question: ${question._id}`);
    return false;
  }

  await bot.telegram.sendPoll(TARGET_CHANNEL_ID, question.question, options, {
    type: 'quiz',
    correct_option_id: correct_option_index,
    is_anonymous: true,
    explanation: question.explanation || 'No explanation.'
  });

  await Question.updateOne({ _id: question._id }, { $set: { isPosted: true } });
  console.log(`✅ MCQ poll posted: "${question.question.substring(0, 40)}..."`);
  return true;
}

async function postCAPoll(caDoc) {
  const pendingQuestion = caDoc.questions.find(q => q.isPosted !== true);
  if (!pendingQuestion) {
    console.log('⚠️ No pending questions in this CA document.');
    return false;
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
  const fullQuestionText = pendingQuestion.question + ` ${caTag}`;

  await bot.telegram.sendPoll(TARGET_CHANNEL_ID, fullQuestionText, options, {
    type: 'quiz',
    correct_option_id: correct_option_index,
    is_anonymous: true,
    explanation: pendingQuestion.explanation || 'No explanation.'
  });

  const pendingIndex = caDoc.questions.indexOf(pendingQuestion);
  await CurrentAffairs.updateOne(
    { _id: caDoc._id },
    { $set: { [`questions.${pendingIndex}.isPosted`]: true } }
  );
  console.log(`✅ CA poll posted: "${pendingQuestion.question.substring(0, 40)}..." ${caTag}`);
  return true;
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

    // Filter to only future posts within 9am-11:30pm window
    const pendingPosts = POST_TIMES.filter(slot => {
      const slotTime = slot.hour * 60 + slot.minute;
      return slotTime >= currentTimeInMinutes && slotTime <= elevenPM + 30;
    });

    if (pendingPosts.length === 0) {
      console.log('⚠️ All scheduled posts for today have passed. Tomorrow is a new day.');
      process.exit(0);
    }

    console.log(`📅 Scheduling ${pendingPosts.length} polls for today`);
    console.log(`📅 Current time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log(`📅 Posts remaining: ${pendingPosts.length}`);

    // Get 3 MCQ and 3 CA questions upfront
    const [mcqDocs, caDocs] = await Promise.all([
      Question.find({
        isPosted: { $ne: true },
        questionType: 'mcq'
      }).sort({ createdAt: 1 }).limit(3),
      CurrentAffairs.find({
        'questions.isPosted': { $ne: true }
      }).sort({ date: 1 }).limit(3)
    ]);

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
          const twoAM = 2 * 60;

          if (currentTime2 > elevenPM + 30 && currentTime2 < nineAM) {
            console.log('⏰ Outside 9am-11:30pm window, skipping post.');
            return;
          }

          // Alternate: MCQ, CA, MCQ, CA, MCQ, CA
          let result = null;
          if (postCount % 2 === 0 && mcqIndex < mcqDocs.length) {
            result = await postMCQPoll(mcqDocs[mcqIndex]);
            if (result) mcqIndex++;
          } else if (caIndex < caDocs.length) {
            result = await postCAPoll(caDocs[caIndex]);
            if (result) caIndex++;
          } else if (mcqIndex < mcqDocs.length) {
            result = await postMCQPoll(mcqDocs[mcqIndex]);
            if (result) mcqIndex++;
          } else if (caIndex < caDocs.length) {
            result = await postCAPoll(caDocs[caIndex]);
            if (result) caIndex++;
          }

          postCount++;
          console.log(`📊 Post ${postCount}/${pendingPosts.length} completed.`);
        } catch (err) {
          console.error('❌ Scheduled post failed:', err.message);
        }
      }, delay);
    }

    console.log(`✅ ${pendingPosts.length} polls scheduled at 30-min intervals. Waiting for delivery...`);
  } catch (err) {
    console.error('❌ Scheduling failed:', err.message);
    process.exit(1);
  }
}

schedulePosts();