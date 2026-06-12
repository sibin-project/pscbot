const mongoose = require("mongoose");

const QuestionSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true
  },
  slug: {
    type: String,
    unique: true
  },
  options: {
    A: String,
    B: String,
    C: String,
    D: String
  },
  correctAnswer: {
    type: String,
    enum: ["A", "B", "C", "D"],
    required: true
  },
  level: {
    type: String,
    enum: ["sslc", "plustwo", "degree"],
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: [
      "general-knowledge",
      "general-science",
      "mathematics",
      "mental-ability",
      "general-english",
      "computer-it",
      "current-affairs"
    ]
  },
  explanation: {
    type: String,
    default: ""
  },
  tags: [{
    type: String
  }],
  questionType: {
    type: String,
    enum: ["mcq", "current-affairs"],
    default: "mcq"
  },
  isApproved: {
    type: Boolean,
    default: true
  },
  isPosted: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

QuestionSchema.index({ level: 1 });
QuestionSchema.index({ category: 1 });

module.exports = mongoose.models.Question || mongoose.model("Question", QuestionSchema);
