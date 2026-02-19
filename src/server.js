const app = require("./app");
const connectDb = require("./config/db");
const env = require("./config/env");
const startAttendanceJobs = require("./cron/attendanceJobs");
const { startCoddyCheckBot, stopCoddyCheckBot } = require("./coddyCheck/bot");

async function bootstrap() {
  try {
    await connectDb();
    startAttendanceJobs();

    app.listen(env.port, () => {
      console.log(`Server listening on port ${env.port}`);
    });

    // Bot start should not block HTTP API startup.
    // Bot start should not block HTTP API startup.
    startCoddyCheckBot().catch((error) => {
      console.error("Coddy bot start failed:", error.message);
    });
  } catch (error) {
    console.error("Failed to bootstrap server:", error.message);
    process.exit(1);
  }
}

bootstrap();

process.once("SIGINT", () => stopCoddyCheckBot("SIGINT"));
process.once("SIGTERM", () => stopCoddyCheckBot("SIGTERM"));
