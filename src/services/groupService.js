const Group = require("../models/Group");

async function ensureDefaultGroups() {
  const defaultGroups = ["Toq", "Juft"];

  for (const name of defaultGroups) {
    const exists = await Group.findOne({ name });
    if (!exists) {
      await Group.create({
        name,
        days: name,
        time: "09:00",
        mentor: "Tizim"
      });
    }
  }
}

module.exports = {
  ensureDefaultGroups
};
