const mentorMainKeyboard = [
  ["📣 O'quvchi chaqirish", "📓 Mening yozuvlarim"],
  ["➕ O'quvchi qo'shish", "⚙️ Sozlamalar"],
  ["ℹ️ Yordam"]
];

const taMainKeyboard = [
  ["📣 O'quvchi chaqirish", "📓 Mening yozuvlarim"],
  ["➕ O'quvchi qo'shish", "⚙️ Sozlamalar"],
  ["ℹ️ Yordam"]
];

const teacherMainKeyboard = mentorMainKeyboard;

const adminMainKeyboard = [["📊 Hisobot", "🔍 Qidiruv"]];

function getWorkerMainKeyboard(role) {
  const normalizedRole = String(role || "").toLowerCase();

  if (normalizedRole === "mentor" || normalizedRole === "mentor_ta") {
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
  getWorkerMainKeyboard
};
