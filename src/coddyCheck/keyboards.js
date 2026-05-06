const mentorMainKeyboard = [
  ["📣 O'quvchi chaqirish"],
  ["💬 Murojat"],
  ["⚙️ Sozlamalar", "ℹ️ Yordam"]
];

const taMainKeyboard = [
  ["➕ O'quvchi qo'shish"],
  ["⚙️ Sozlamalar", "ℹ️ Yordam"]
];

const mentorTaMainKeyboard = [
  ["📣 O'quvchi chaqirish", "➕ O'quvchi qo'shish"],
  ["💬 Murojat"],
  ["⚙️ Sozlamalar", "ℹ️ Yordam"]
];

const teacherMainKeyboard = mentorMainKeyboard;

const adminMainKeyboard = [["📊 Hisobot", "🔍 Qidiruv"]];

const supportMainKeyboard = [
  ["🧑‍💼 Kuratorlar", "👥 Mentorlar", "🧑‍🏫 TA lar"],
  ["📊 Statistika", "ℹ️ Yordam"]
];

function getWorkerMainKeyboard(role) {
  const normalizedRole = String(role || "").toLowerCase();

  if (normalizedRole === "mentor_ta") {
    return mentorTaMainKeyboard;
  }

  if (normalizedRole === "mentor") {
    return mentorMainKeyboard;
  }

  if (normalizedRole === "ta") {
    return taMainKeyboard;
  }

  return teacherMainKeyboard;
}

module.exports = {
  mentorMainKeyboard,
  taMainKeyboard,
  teacherMainKeyboard,
  adminMainKeyboard,
  supportMainKeyboard,
  getWorkerMainKeyboard
};

