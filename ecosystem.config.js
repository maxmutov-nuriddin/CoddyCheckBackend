// PM2 process config for attendance-bot-backend
//
// IMPORTANT: exec_mode MUST stay "fork" (not "cluster").
// Cluster mode would spawn multiple processes, each starting its own
// Telegram polling loop — Telegram API rejects duplicate pollers.
// All in-memory state (bot instance, OTP store, staff cache, auth cache)
// lives in a single process and must remain so.
//
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js --env production
//   pm2 save && pm2 startup          ← survive server reboots
//   pm2 logs attendance-backend      ← live logs
//   pm2 monit                        ← real-time CPU/RAM dashboard

module.exports = {
  apps: [
    {
      name: "attendance-backend",
      script: "src/server.js",

      // Single instance — required for Telegram polling bot
      instances: 1,
      exec_mode: "fork",

      // Restart if RSS memory exceeds 512 MB (guards against slow leaks)
      max_memory_restart: "512M",

      // Restart policy: up to 10 restarts; if it dies within 5s it's a
      // crash-loop and PM2 stops retrying to avoid log flooding
      max_restarts: 10,
      min_uptime: "5s",
      restart_delay: 1000,

      // Never watch files in production — causes unnecessary restarts
      watch: false,

      // Log rotation — prevent disk fill on a long-running server
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
