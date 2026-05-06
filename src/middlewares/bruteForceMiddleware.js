// IP asosida login urinishlarini nazorat qiluvchi middleware
// Har bir IP dan 2 marta noto'g'ri urinish → 3-chida 15 daqiqa blok

const _ipAttempts = new Map(); // ip → { failedCount, blockedUntil, lastAttempt }
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 daqiqa
const MAX_FAILED = 2; // 2 ta noto'g'ri urinishdan keyin keyingi bloklanadi

// Eskirgan yozuvlarni 30 daqiqada bir tozalash
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of _ipAttempts) {
    const blockExpired = !record.blockedUntil || record.blockedUntil <= now;
    const stale = now - record.lastAttempt > BLOCK_DURATION_MS;
    if (blockExpired && stale) _ipAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

function loginBruteForce(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  const record = _ipAttempts.get(ip) ?? { failedCount: 0, blockedUntil: 0, lastAttempt: now };

  // Hali ham blok davom etyaptimi?
  if (record.blockedUntil > now) {
    const remainingMin = Math.ceil((record.blockedUntil - now) / 60_000);
    return res.status(429).json({
      success: false,
      message: `Juda ko'p noto'g'ri urinish. ${remainingMin} daqiqadan so'ng qayta urinib ko'ring.`,
      blockedForMinutes: remainingMin,
    });
  }

  // Blok muddati tugagan bo'lsa — reset
  if (record.blockedUntil > 0 && record.blockedUntil <= now) {
    record.failedCount = 0;
    record.blockedUntil = 0;
  }

  // Allaqachon max failed — bu request ham bloklansin
  if (record.failedCount >= MAX_FAILED) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    record.lastAttempt = now;
    _ipAttempts.set(ip, record);
    return res.status(429).json({
      success: false,
      message: "Juda ko'p noto'g'ri urinish. Siz 15 daqiqaga bloklandingiz.",
      blockedForMinutes: 15,
    });
  }

  // Response ni ushlab, natijaga qarab hisoblash
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const current = _ipAttempts.get(ip) ?? { failedCount: 0, blockedUntil: 0, lastAttempt: 0 };

    if (res.statusCode === 401) {
      // Noto'g'ri login urinish
      current.failedCount = (current.failedCount || 0) + 1;
      current.lastAttempt = Date.now();

      if (current.failedCount >= MAX_FAILED) {
        // Keyingi urinishda bloklash haqida ogohlantirish
        if (body && typeof body === "object") {
          body.warning = "Diqqat! Keyingi noto'g'ri urinishda siz 15 daqiqaga bloklanasiz.";
          body.remainingAttempts = 0;
        }
      } else {
        if (body && typeof body === "object") {
          body.remainingAttempts = MAX_FAILED - current.failedCount;
        }
      }

      _ipAttempts.set(ip, current);
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      // Muvaffaqiyatli login — bu IP hisobini tozalash
      _ipAttempts.delete(ip);
    }

    return originalJson(body);
  };

  next();
}

module.exports = { loginBruteForce };
