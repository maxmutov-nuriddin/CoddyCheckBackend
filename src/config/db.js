const mongoose = require("mongoose");
const env = require("./env");

async function connectDb() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is missing in environment variables");
  }

  await mongoose.connect(env.mongoUri, {
    autoIndex: true,
    // Default pool is 5 — raise to handle concurrent dashboard refreshes
    // from multiple staff without queuing. Atlas M0 allows 500 total connections.
    maxPoolSize: 10,
    // Fail fast if Atlas is unreachable instead of hanging indefinitely
    serverSelectionTimeoutMS: 5000,
    // Close idle sockets before Atlas's own 30s server-side timeout
    socketTimeoutMS: 45000,
  });

  console.log("MongoDB connected");
}

module.exports = connectDb;
