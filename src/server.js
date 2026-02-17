const app = require("./app");
const connectDb = require("./config/db");
const env = require("./config/env");
const startAttendanceJobs = require("./cron/attendanceJobs");
const { ensureDefaultGroups } = require("./services/groupService");

async function bootstrap() {
  try {
    await connectDb();
    await ensureDefaultGroups();
    startAttendanceJobs();

    app.listen(env.port, () => {
      console.log(`Server listening on port ${env.port}`);
    });
  } catch (error) {
    console.error("Failed to bootstrap server:", error.message);
    process.exit(1);
  }
}

bootstrap();
