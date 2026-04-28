require('dotenv').config();
const mongoose = require('mongoose');

async function resetHistory() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB.');

    const QuestionSchema = new mongoose.Schema({
      is_posted: Boolean
    });
    const Question = mongoose.model('Question', QuestionSchema);

    const result = await Question.updateMany({}, { is_posted: false });
    
    console.log(`✅ Successfully reset ${result.modifiedCount} questions. They can now be posted again!`);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

resetHistory();
