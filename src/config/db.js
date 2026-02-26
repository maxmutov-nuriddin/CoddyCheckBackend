const mongoose = require("mongoose");
const env = require("./env");

async function connectDb() {
  if (!env.mongoUri) {
    throw new Error("MONGO_URI is missing in environment variables");
  }

  await mongoose.connect(env.mongoUri, {
    autoIndex: true,
    maxPoolSize: 10,
    // Fail fast if Atlas is unreachable
    serverSelectionTimeoutMS: 8000,
    // Don't let active queries hang too long — fail at 15s instead of 45s
    socketTimeoutMS: 15000,
    // Heartbeat every 5s to detect drops earlier (default 10s)
    heartbeatFrequencyMS: 5000,
  });

  console.log("MongoDB connected");

  mongoose.connection.on("disconnected", () => {
    console.warn("[MongoDB] Disconnected — Mongoose will auto-reconnect");
  });

  mongoose.connection.on("reconnected", () => {
    console.log("[MongoDB] Reconnected");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[MongoDB] Connection error:", err.message);
  });
}

module.exports = connectDb;
