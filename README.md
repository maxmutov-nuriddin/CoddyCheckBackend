# Attendance Backend (API + Telegram Bot)

Bu servis o'quvchi davomatini boshqaradi, mentor/TA chaqiruvlarini yuritadi, Telegram bot bilan integratsiya qiladi va kunlik cron vazifalarni bajaradi.

## 1. Texnologiyalar
- Node.js
- Express.js
- MongoDB + Mongoose
- JWT autentifikatsiya
- node-cron
- Telegraf (Coddy bot)
- Luxon (timezone/date helper)

## 2. Asosiy imkoniyatlar
- Kurator uchun login/register va profil boshqaruvi
- O'quvchilar CRUD va muzlatilganlar filtri
- Guruhlar va ishchilar (mentor/TA) boshqaruvi
- Chaqirish, keldi/kelmadi statuslari, recall oqimi
- Botdan kelgan call requestlarni tasdiqlash
- O'quvchilar sahifasi uchun alohida chaqiruvlar oqimi
- Analitika va natijalar endpointlari
- Telegram bot callback va Coddy webhook
- Avtomatik cron eslatmalar va 20:00 auto-close

## 3. Papka tuzilmasi
```txt
src/
  app.js
  server.js
  config/
  controllers/
  models/
  routes/
  middlewares/
  services/
  utils/
  cron/
  coddyCheck/
```

## 4. Talablar
- Node.js 18+
- MongoDB (Atlas yoki local)

## 5. O'rnatish
```bash
cd backend
npm install
```

## 6. Environment o'zgaruvchilar
`backend/.env` fayl yarating:

```env
NODE_ENV=development
PORT=5000
MONGO_URI=mongodb://localhost:27017/attendance
JWT_SECRET=change_me
JWT_EXPIRES_IN=7d
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_API_BASE=https://api.telegram.org
APP_TIMEZONE=Asia/Tashkent

# Coddy bot integration
CODDY_BOT_TOKEN=
CODDY_PUBLIC_URL=
CODDY_ADMIN_IDS=
CODDY_ALLOWED_IDS=
```

Muhim:
- `.env` dagi token va parollarni gitga qo'shmang.
- `APP_TIMEZONE` cron va bot vaqtlariga bevosita ta'sir qiladi.

## 7. Ishga tushirish
```bash
# development
npm run dev

# production
npm start
```

Health check:
- `GET /api/health`

## 8. Rollar va kirish siyosati
- Web platformaga kiruvchi rol: `kurator`
- Botda ishlovchi rollar: `mentor`, `ta`, `mentor_ta`, `kurator`
- Birinchi registerdan keyin tizimda faqat bitta kurator akkaunt bo'lishi cheklangan

## 9. API javob formati
Muvaffaqiyatli javob:
```json
{
  "success": true,
  "message": "Success",
  "data": {}
}
```

Xatolik javobi:
```json
{
  "success": false,
  "message": "Error message"
}
```

## 10. Endpointlar

### Auth (`/api/auth`)
- `POST /register` - kurator yaratish
- `POST /login` - kurator login
- `GET /me` - joriy foydalanuvchi
- `PATCH /profile` - profil yangilash
- `PATCH /password` - parol almashtirish
- `DELETE /account` - akkauntni o'chirish

### Students (`/api/students`) - auth + kurator
- `GET /`
- `POST /`
- `PATCH /:id`
- `DELETE /:id`
- `GET /frozen`

### Workers (`/api/workers`) - auth + kurator
- `GET /`
- `POST /`
- `PATCH /:id`
- `DELETE /:id`

### Groups (`/api/groups`) - auth
- `GET /` (authed user)
- `POST /` (kurator)
- `PUT /:id` (kurator)
- `DELETE /:id` (kurator)

### Attendance (`/api/attendance`)
- `POST /bot/webhook` - Telegram callback (`keldi:ID`, `kelmadi:ID`)
- `POST /manual` - manual keldi/kelmadi
- `POST /ta-notify` - TA notification task yaratish
- `PATCH /bot-request/:id/confirm` - bot call so'rovini tasdiqlash
- `POST /call` - o'quvchini chaqirish
- `PATCH /:id/arrival-confirm` - kelganini tasdiqlash
- `PATCH /:id/status` - status yangilash
- `POST /:id/recall` - qayta chaqirish
- `GET /called` - chaqirilganlar ro'yxati (date filter)
- `GET /report` - kunlik hisobot
- `GET /results` - natijalar agregatsiyasi
- `GET /recent-activity` - so'nggi faollik
- `DELETE /activity/:id` - activity o'chirish
- `POST /called-students` - CalledStudent yozuvi
- `GET /called-students` - CalledStudent ro'yxati
- `DELETE /called-students/:id`

### Activity (`/api/activity`) - auth + kurator
- `GET /all`

### Bot (`/api/bot`) - auth + kurator
- `GET /calls` - faqat `call_extra`/`keep` oqimi (`date` filter bilan)

### Analytics (`/api/analytics`) - auth + kurator
- `GET /`

### Coddy Webhook
- `POST /api/telegram/coddy`

## 11. Cron jadvali (APP_TIMEZONE bo'yicha)
- `0 9 * * *`
  - bugungi chaqirilganlar bo'yicha TA reminder (inline tugmalar bilan)
  - TA notification tasklar yuboriladi (09:00 eslatma)
- `0 9 * * *`
  - ertalabki salom xabarlari
- `0 20 * * *`
  - bugungi statusi `null` bo'lganlarni auto-close:
    - `arrivalConfirmedAt` bor bo'lsa `keldi`
    - aks holda `kelmadi`
  - ertangi chaqiruvlar bo'yicha TA reminder
  - mentorlarga kelmagan chaqirilganlar haqida xabar
- Coddy modul ichida alohida `20:00` daily report cron mavjud

## 12. Muhim biznes qoidalar
- `callStatus` va `attendanceStatus` alohida maydon
- `attendanceStatus` bir necha marta yangilanishi mumkin (log saqlanadi)
- Recall faqat oldingi holat `kelmadi` bo'lsa ruxsat etiladi
- O'chirilgan o'quvchi tarixi saqlanadi
- Chaqirilganlar ro'yxati sana bo'yicha ishlaydi
- Bot call list endpointida `date` parametri berilsa eski yozuvlar aralashmaydi

## 13. Coddy bot haqida qisqacha
- Bot `CODDY_BOT_TOKEN` bo'lsa server startda avtomatik ishga tushadi
- Development: polling mode
- Production + `CODDY_PUBLIC_URL`: webhook mode (`/api/telegram/coddy`)
- Rollarga qarab tugmalar farqlanadi (`mentor`, `ta`, `mentor_ta`, `kurator`)

## 14. Tezkor diagnostika
- API ishlashini tekshirish: `GET /api/health`
- Mongo ulanish xatosi: `MONGO_URI` ni tekshiring
- Bot ishlamasa:
  - `CODDY_BOT_TOKEN` to'g'ri ekanini tekshiring
  - webhook bo'lsa public URL va HTTPS ni tekshiring
  - `CODDY_ADMIN_IDS` formatini (`1,2,3`) tekshiring
