require('dotenv').config();

/**
 * send_message.js
 *
 * Auto-posts the LATEST available Current Affairs entry from the DB —
 * not limited to "today". Safe to run on a cron schedule: it tracks the
 * last date it posted and skips re-sending if nothing new has been added.
 */

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const CurrentAffairs = require('./models/CurrentAffairs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = '-1003944522871';

// Where we remember the last date we actually posted, so cron runs
// don't repost the same "latest" CA over and over.
const STATE_FILE = path.join(__dirname, '.last_posted_ca_date.json');

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file.');
  process.exit(1);
}

const args = process.argv.slice(2);

// Extract mode flag
const modeFlag = args.find(a => a === '--html' || a === '--markdown');
// Allow forcing a post even if it matches the last-posted date (manual override)
const forceFlag = args.includes('--force');
let inputMessage = args.filter(a => !a.startsWith('--')).join(' ');

let parseMode = undefined;
let message = '';
const bot = new Telegraf(BOT_TOKEN);

// Safely handles both JS Date objects from Mongoose and YYYY-MM-DD strings
function getFormattedDates(dateValue) {
  if (!dateValue) return null;

  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return null;

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  return {
    displayDate: `${day}/${month}/${year}`,
    linkDate: `${year}-${month}-${day}`
  };
}

function readLastPostedDate() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw).linkDate || null;
  } catch {
    return null; // no state file yet — first run
  }
}

function writeLastPostedDate(linkDate) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ linkDate, postedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.warn('⚠️ Could not persist last-posted state:', err.message);
  }
}

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
}

// Always fetches the absolute latest CA in the DB — regardless of whether
// it matches today's date. CA_DATE_FOR_LINK env var still lets you force
// a specific date manually if you ever need to.
async function getLatestCaDate() {
  if (process.env.CA_DATE_FOR_LINK) {
    return process.env.CA_DATE_FOR_LINK;
  }

  try {
    await connectDB();
    const latestDoc = await CurrentAffairs.findOne({}).sort({ date: -1 }).lean();
    return latestDoc?.date || null;
  } catch (err) {
    console.warn('⚠️ Could not fetch latest CA date from DB:', err.message);
    return null;
  }
}

async function buildMessage() {
  const latestCaDate = await getLatestCaDate();

  if (!inputMessage.trim()) {
    if (!latestCaDate) {
      console.log('⚠️ No CA available in DB yet. Skipping message send.');
      return false;
    }

    const dates = getFormattedDates(latestCaDate);
    if (!dates) {
      console.log('⚠️ Invalid date format retrieved from DB. Skipping.');
      return false;
    }

    // Duplicate-post guard: skip if we already posted this exact CA date,
    // unless --force is passed.
    if (!forceFlag) {
      const lastPosted = readLastPostedDate();
      if (lastPosted === dates.linkDate) {
        console.log(`ℹ️ Latest CA (${dates.linkDate}) was already posted. Skipping (use --force to repost).`);
        return false;
      }
    }

    message = `<b>📢 Kerala PSC Daily Updates! 📢</b>
📅 ${dates.displayDate} കറന്റ് അഫയേഴ്സും ക്വിസും ഇപ്പോൾ ലൈവ് ആണ്! 🎯
✅ Daily CA Quiz
✅ Important Updates

താഴെയുള്ള ലിങ്ക് വഴി ഇപ്പോൾ തന്നെ ചെക്ക് ചെയ്യൂ:
🔗 https://psc-malayali.vercel.app/current-affairs/date/${dates.linkDate}

#KeralaPSC #DailyQuiz #PSCExam`;

    parseMode = 'HTML';
    // stash so we can mark it posted after a successful send
    buildMessage._linkDate = dates.linkDate;
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

    // Remember this date so a repeated cron run today won't repost it
    if (buildMessage._linkDate) {
      writeLastPostedDate(buildMessage._linkDate);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to send message:', err.message);
    process.exit(1);
  }
}

sendMessage();