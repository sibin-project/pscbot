require('dotenv').config();

/**
 * send-bulk-ca-msg.js
 *
 * Bulk sends CA messages for a date range (August 8 to September 2, 2026)
 * Each date gets its own message with link to that day's CA page
 */

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = '-1003944522871';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in .env file.');
  process.exit(1);
}

// Parse date range from command line arguments or use default Aug 8 to Sep 2, 2026
const args = process.argv.slice(2);
let startDate = new Date('2026-08-08');
let endDate = new Date('2026-09-02');

// Allow overriding dates via command line: --start YYYY-MM-DD --end YYYY-MM-DD
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--start' && args[i + 1]) {
    startDate = new Date(args[i + 1]);
    i++;
  } else if (args[i] === '--end' && args[i + 1]) {
    endDate = new Date(args[i + 1]);
    i++;
  }
}

const bot = new Telegraf(BOT_TOKEN);

// Format date for display and link
function getFormattedDates(dateValue) {
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

// Connect to MongoDB
async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    family: 4,
    serverSelectionTimeoutMS: 10000,
  });
}

// Send message for a specific date
async function sendMessageForDate(date) {
  try {
    const dates = getFormattedDates(date);
    if (!dates) {
      console.log(`⚠️ Invalid date: ${date}`);
      return false;
    }

    const message = `<b>📢 Kerala PSC Daily Updates! 📢</b>
📅 ${dates.displayDate} FULL CA + CA Exam Update
✅ Check the latest Current Affairs
✅ Exam preparation materials

താഴെയുള്ള ലിങ്ക് വഴി ${dates.displayDate} നിയതം ചെയ്ത CA പരിശോധനകൾ:
🔗 https://psc-malayali.codenaxa.in/current-affairs/date/${dates.linkDate}

#KeralaPSC #DailyCA #CAExam`;

    console.log(`📤 Sending message for ${dates.displayDate}...`);

    const result = await bot.telegram.sendMessage(CHANNEL_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });

    console.log(`✅ Message sent for ${dates.displayDate}!`);
    console.log(`   Date: ${new Date(result.date * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    
    // Small delay between messages to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  } catch (err) {
    console.error(`❌ Failed to send message for ${date}:`, err.message);
    return false;
  }
}

// Main function to iterate through date range
async function sendBulkMessages() {
  try {
    await connectDB();
    
    console.log(`📅 Sending bulk CA messages from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    
    let currentDate = new Date(startDate);
    const end = new Date(endDate);
    let count = 0;
    let successCount = 0;
    
    while (currentDate <= end) {
      count++;
      const success = await sendMessageForDate(currentDate);
      if (success) successCount++;
      
      // Increment date by 1 day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log(`\n📊 Bulk messaging complete: ${successCount}/${count} messages sent successfully`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Bulk messaging failed:', err.message);
    process.exit(1);
  }
}

sendBulkMessages();