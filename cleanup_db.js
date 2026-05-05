require('dotenv').config();
process.env.TZ = 'Asia/Kolkata';
const mongoose = require('mongoose');

async function cleanup() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
    console.log('Connected to MongoDB');

    // Use a loose schema just for cleanup
    const Question = mongoose.model('Question', new mongoose.Schema({
      question: String,
      options: [String],
      explanation: String,
      correct_option_index: Number
    }));

    console.log('Cleaning up invalid questions...');
    const result = await Question.deleteMany({
      $or: [
        { question: { $exists: false } },
        { question: "" },
        { options: { $exists: false } },
        { options: { $size: 0 } },
        { explanation: { $exists: false } },
        { explanation: "" },
        { correct_option_index: { $exists: false } }
      ]
    });

    console.log(`✅ Successfully deleted ${result.deletedCount} invalid question sets.`);
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

cleanup();
