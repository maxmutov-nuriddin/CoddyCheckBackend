# Student Attendance + Bot Integration Backend

Node.js + Express + MongoDB (Mongoose) backend for attendance, call-status and Telegram bot reminders.

## Stack
- Node.js + Express.js
- MongoDB + Mongoose
- JWT auth
- node-cron
- Telegram Bot API

## Project Structure

```txt
src/
 ├── config/
 ├── controllers/
 ├── services/
 ├── models/
 ├── routes/
 ├── middlewares/
 ├── cron/
 ├── utils/
 ├── app.js
 └── server.js
```

## Setup

1. Create `.env` from `.env.example`
2. Fill `MONGO_URI`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`
3. Install deps: `npm install`
4. Run dev: `npm run dev`

## Access Policy (Updated)
- Web/API login: **only `kurator`**
- Login credentials format: **phone + password `1234`**
- `mentor` and `ta`: **do not login to web**, they work via Telegram bot flow

## Collections
- `users`
- `groups`
- `students`
- `attendances`
- `attendancestatuslogs`

## API Endpoints

### Auth
- `POST /api/auth/register` (creates only `kurator`, password fixed to `1234`)
- `POST /api/auth/login` (only kurator, password `1234`)

### Students (kurator only)
- `GET /api/students`
- `POST /api/students`
- `PATCH /api/students/:id`
- `DELETE /api/students/:id` (soft delete -> `isActive=false`)
- `GET /api/students/frozen?status=qarzdor`

### Attendance
- `POST /api/attendance/bot/webhook` (Telegram callback handler)
- Authenticated web endpoints (kurator only):
  - `POST /api/attendance/manual`
  - `POST /api/attendance/call`
  - `PATCH /api/attendance/:id/arrival-confirm`
  - `PATCH /api/attendance/:id/status`
  - `POST /api/attendance/:id/recall`
  - `GET /api/attendance/called?date=YYYY-MM-DD`
  - `GET /api/attendance/report?date=YYYY-MM-DD`

## Cron Jobs
- `0 20 * * *` -> tomorrow called students reminder to TAs
- `0 8 * * *` -> today called students + inline `Keldi/Kelmadi` buttons
- `59 23 * * *` -> auto close null attendance:
  - if `arrivalConfirmedAt` exists => `keldi`
  - otherwise => `kelmadi`

## Business Rules Implemented
- `callStatus` and `attendanceStatus` are separate fields
- multiple calls in one day create separate attendance records
- TA can update attendance status multiple times (status changes logged)
- deleted student does not remove attendance history
- re-call only allowed when previous attendance is `kelmadi`
- frozen student calling is currently **allowed** (business choice)

## Notes
- Default groups `Toq` and `Juft` are auto-created on server start.
- Telegram webhook can be protected via `TELEGRAM_WEBHOOK_SECRET` and header `x-telegram-bot-api-secret-token`.
