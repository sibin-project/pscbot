require('dotenv').config();

/**
 * send_message.js
 */

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const CurrentAffairs = require('./models/CurrentAffairs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = '-1003944522871';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file.');
  process.exit(1);
}

const args = process.argv.slice(2);

// Extract mode flag
const modeFlag = args.find(a => a === '--html' || a === '--markdown');
let inputMessage = args.filter(a => !a.startsWith('--')).join(' ');

let parseMode = undefined;
let message = '';
const bot = new Telegraf(BOT_TOKEN);

function formatDateFromValue(dateValue) {
  if (!dateValue) return null;
  const [year, month, day] = String(dateValue).split('-').map(part => part.trim());
  if (!year || !month || !day) return null;
  return `${day}/${month}/${year}`;
}

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
}

async function getLatestCaDate() {
  if (process.env.CA_DATE_FOR_LINK) {
    return process.env.CA_DATE_FOR_LINK;
  }

  try {
    await connectDB();
    const latestDoc = await CurrentAffairs.findOne({}).sort({ date: -1 }).lean();
    return latestDoc?.date || null;
  } catch (err) {
    console.warn('⚠️ Could not fetch latest CA date from DB, falling back to current date:', err.message);
    return null;
  }
}

async function buildMessage() {
  const date = new Date();
  const day = date.getDate();
  const month = (date.getMonth() + 1) < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1;
  const year = date.getFullYear();
  const latestCaDate = await getLatestCaDate();

  if (!inputMessage.trim()) {
    if (!latestCaDate) {
      console.log('⚠️ No latest CA available in DB. Skipping message send.');
      return false;
    }

    const caDateForLink = latestCaDate;
    const displayDate = formatDateFromValue(caDateForLink) || `${day}/${month}/${year}`;
    message = `<b>📢 Kerala PSC Daily Updates! 📢</b>
📅 ${displayDate} കറന്റ് അഫയേഴ്സും ക്വിസും ഇപ്പോൾ ലൈവ് ആണ്! 🎯
✅ Daily CA Quiz
✅ Important Updates

താഴെയുള്ള ലിങ്ക് വഴി ഇപ്പോൾ തന്നെ ചെക്ക് ചെയ്യൂ:
🔗https://psc-malayali.codenaxa.in/current-affairs/date/${caDateForLink}

#KeralaPSC #DailyQuiz #PSCExam`;
    parseMode = 'HTML';
    return true;
  } else {
    message = inputMessage;
    if (modeFlag === '--html') parseMode = 'HTML';
    if (modeFlag === '--markdown') parseMode = 'MarkdownV2';
  }
  return true;
}

async function sendMessage() {
  try {
    const canSend = await buildMessage();
    if (!canSend) {
      process.exit(0);
    }
    console.log(`📤 Sending message to channel ${CHANNEL_ID}...`);

    const result = await bot.telegram.sendMessage(CHANNEL_ID, message, {
      parse_mode: parseMode,
      disable_web_page_preview: false,
    });

    console.log('✅ Message sent successfully!');
    console.log(`   Date: ${new Date(result.date * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to send message:', err.message);
    process.exit(1);
  }
}

sendMessage();