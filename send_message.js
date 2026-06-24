require('dotenv').config();

/**
 * send_message.js
 */

const { Telegraf } = require('telegraf');

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
let message = "";
const date = new Date();
const day = date.getDate();
const month =  (date.getMonth() + 1)<10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1;
const year = date.getFullYear();
// നീ ആവശ്യപ്പെട്ട മെസ്സേജ് ഇവിടെ സെറ്റ് ചെയ്യുന്നു
if (!inputMessage.trim()) {
  message = `<b>📢 Kerala PSC Daily Updates! 📢</b>
📅 ${day-1}/${month}/${year}

ഇന്നത്തെ കറന്റ് അഫയേഴ്‌സും ക്വിസും ഇപ്പോൾ ലൈവ് ആണ്! 🎯
✅ Daily CA Quiz
✅ Important Updates

താഴെയുള്ള ലിങ്ക് വഴി ഇപ്പോൾ തന്നെ ചെക്ക് ചെയ്യൂ:
🔗 <a href='https://psc-malayali.codenaxa.in/current-affairs/date/${year}-${month}-${day-1}'>Check Now</a>

#KeralaPSC #DailyQuiz #PSCExam`;
  parseMode = 'HTML';
} else {
  message = inputMessage;
  if (modeFlag === '--html') parseMode = 'HTML';
  if (modeFlag === '--markdown') parseMode = 'MarkdownV2';
}

const bot = new Telegraf(BOT_TOKEN);

async function sendMessage() {
  try {
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