const mongoose = require("mongoose");
const env = require("./env");

async function connectDb() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is missing in environment variables");
  }

  await mongoose.connect(env.mongoUri, {
    autoIndex: true
  });

  console.log("MongoDB connected");
}

module.exports = connectDb;
