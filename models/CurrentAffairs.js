const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  heading: String,
  summary: String
});

const caQuestionSchema = new mongoose.Schema({
  question: String,
  options: {
    A: String,
    B: String,
    C: String,
    D: String
  },
  correctAnswer: String,
  explanation: String,
  isPosted: {
    type: Boolean,
    default: false
  }
});

const currentAffairsSchema = new mongoose.Schema({
  date: {
    type: String,
    required: true,
    unique: true // YYYY-MM-DD
  },
  dateDisplay: String,
  articles: [articleSchema],
  questions: [caQuestionSchema],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.CurrentAffairs || mongoose.model('CurrentAffairs', currentAffairsSchema);
