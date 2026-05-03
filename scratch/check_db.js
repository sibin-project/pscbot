require('dotenv').config();
const mongoose = require('mongoose');

async function checkSchema() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { family: 4 });
    console.log('Connected to MongoDB');

    const db = mongoose.connection.db;
    const questions = await db.collection('questions').find().limit(5).toArray();
    console.log('Sample documents:', JSON.stringify(questions, null, 2));

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

checkSchema();
