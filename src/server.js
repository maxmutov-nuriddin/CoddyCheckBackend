const mongoose = require("mongoose");
const app = require("./app");
const connectDb = require("./config/db");
const env = require("./config/env");
const startAttendanceJobs = require("./cron/attendanceJobs");
const { startCoddyCheckBot, stopCoddyCheckBot } = require("./coddyCheck/bot");

let server = null;
let isShuttingDown = false;

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(error);
    };

    const instance = app.listen(env.port, () => {
      instance.off("error", onError);
      console.log(`Server listening on port ${env.port}`);
      resolve(instance);
    });

    instance.once("error", onError);
  });
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, shutting down gracefully...`);

  stopCoddyCheckBot(signal);

  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  await mongoose.connection.close();
  process.exit(0);
}

async function bootstrap() {
  try {
    await connectDb();
    server = await startHttpServer();
    startAttendanceJobs();

    // Bot start should not block HTTP API startup.
    startCoddyCheckBot().catch((error) => {
      console.error("Coddy bot start failed:", error.message);
    });
  } catch (error) {
    const message =
      error.code === "EADDRINUSE"
        ? `Port ${env.port} is already in use`
        : error.message;

    await mongoose.connection.close().catch(() => {});
    console.error("Failed to bootstrap server:", message);
    process.exit(1);
  }
}

bootstrap();

process.once("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("Graceful shutdown failed:", error.message);
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("Graceful shutdown failed:", error.message);
    process.exit(1);
  });
});
