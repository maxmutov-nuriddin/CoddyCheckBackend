const Group = require("../models/Group");
const Student = require("../models/Student");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/response");

const getGroups = asyncHandler(async (req, res) => {
   const groups = await Group.find().sort({ days: -1, time: 1, name: 1 });
   return ok(res, groups, "Groups list");
});

const createGroup = asyncHandler(async (req, res) => {
   const { name, days, time, mentor } = req.body;

   if (!name || !days || !time || !mentor) {
      throw new ApiError(400, "Barcha maydonlar to'ldirilishi shart");
   }

   if (!["Toq", "Juft"].includes(days)) {
      throw new ApiError(400, "Kunlar faqat 'Toq' yoki 'Juft' bo'lishi mumkin");
   }

   const exists = await Group.findOne({ name, days });
   if (exists) {
      throw new ApiError(400, "Bu guruh allaqachon mavjud");
   }

   const group = await Group.create({
      name,
      days,
      time,
      mentor
   });

   return created(res, group, "Guruh yaratildi");
});

const deleteGroup = asyncHandler(async (req, res) => {
   const { id } = req.params;

   const group = await Group.findById(id);
   if (!group) {
      throw new ApiError(404, "Guruh topilmadi");
   }

   // Check if group has students
   const studentCount = await Student.countDocuments({ groupId: id });
   if (studentCount > 0) {
      throw new ApiError(400, `Guruhda ${studentCount} ta o'quvchi bor. Avval ularni o'chiring yoki boshqa guruhga o'tkazing.`);
   }

   await Group.findByIdAndDelete(id);

   return ok(res, null, "Guruh o'chirildi");
});

module.exports = {
   getGroups,
   createGroup,
   deleteGroup
};
