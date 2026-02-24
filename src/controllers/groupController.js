const Group = require("../models/Group");
const Student = require("../models/Student");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/response");

const MAX_BULK_STUDENTS = 500;
const URL_REGEX = /^https?:\/\/\S+$/i;
const ALLOWED_STATUSES = new Set(["good", "average", "poor", "lead", "frozen"]);

function normalizeNameKey(value) {
   return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
}

function sanitizeText(value, maxLength = 255) {
   const cleaned = String(value || "")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
   return cleaned.slice(0, maxLength);
}

function sanitizeProfileUrl(value) {
   const cleaned = String(value || "")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 2048);

   if (!cleaned) return "";
   return URL_REGEX.test(cleaned) ? cleaned : "";
}

function mapIncomingStatus(value) {
   const normalized = String(value || "").trim().toLowerCase();
   if (!normalized || normalized === "active") return "good";
   if (ALLOWED_STATUSES.has(normalized)) return normalized;
   return "good";
}

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

   // Check if group has active students
   const studentCount = await Student.countDocuments({ groupId: id, isActive: true });
   if (studentCount > 0) {
      throw new ApiError(400, `Guruhda ${studentCount} ta o'quvchi bor. Avval ularni o'chiring yoki boshqa guruhga o'tkazing.`);
   }

   await Group.findByIdAndDelete(id);

   return ok(res, null, "Guruh o'chirildi");
});

const updateGroup = asyncHandler(async (req, res) => {
   const { id } = req.params;
   const { name, days, time, mentor } = req.body;

   const group = await Group.findById(id);
   if (!group) {
      throw new ApiError(404, "Guruh topilmadi");
   }

   if (name) group.name = name;
   if (days) group.days = days;
   if (time) group.time = time;
   if (mentor) group.mentor = mentor;

   await group.save();

   return ok(res, group, "Guruh yangilandi");
});

const bulkAddStudents = asyncHandler(async (req, res) => {
   const { id } = req.params;
   const incomingStudents = Array.isArray(req.body?.students) ? req.body.students : [];

   if (incomingStudents.length === 0) {
      throw new ApiError(400, "students ro'yxati bo'sh bo'lmasligi kerak");
   }

   if (incomingStudents.length > MAX_BULK_STUDENTS) {
      throw new ApiError(400, `Bir martada ko'pi bilan ${MAX_BULK_STUDENTS} ta o'quvchi qo'shish mumkin`);
   }

   const group = await Group.findById(id).lean();
   if (!group) {
      throw new ApiError(404, "Guruh topilmadi");
   }

   const existingStudents = await Student.find({ groupId: id, isActive: true }).select("fullName").lean();
   const existingNameSet = new Set(existingStudents.map((row) => normalizeNameKey(row.fullName)));
   const requestNameSet = new Set();

   const duplicates = [];
   const invalidRows = [];
   const studentsToInsert = [];

   incomingStudents.forEach((row, index) => {
      const name = sanitizeText(row?.name ?? row?.fullName ?? "", 120);
      if (!name) {
         invalidRows.push({ index, reason: "Ism bo'sh" });
         return;
      }

      const nameKey = normalizeNameKey(name);
      if (existingNameSet.has(nameKey) || requestNameSet.has(nameKey)) {
         duplicates.push(name);
         return;
      }

      requestNameSet.add(nameKey);
      existingNameSet.add(nameKey);

      studentsToInsert.push({
         fullName: name,
         groupId: id,
         frozenStatus: mapIncomingStatus(row?.status),
         comment: sanitizeText(row?.izoh ?? row?.comment ?? "", 500),
         profileUrl: sanitizeProfileUrl(row?.link ?? row?.profileUrl ?? ""),
         isActive: true
      });
   });

   if (studentsToInsert.length === 0) {
      return ok(
         res,
         {
            groupId: id,
            groupName: group.name,
            createdCount: 0,
            duplicateCount: duplicates.length,
            invalidCount: invalidRows.length,
            duplicates: Array.from(new Set(duplicates)).slice(0, 20),
            invalidRows
         },
         "Yangi o'quvchi qo'shilmadi"
      );
   }

   const inserted = await Student.insertMany(studentsToInsert, { ordered: true });

   return created(
      res,
      {
         groupId: id,
         groupName: group.name,
         createdCount: inserted.length,
         duplicateCount: duplicates.length,
         invalidCount: invalidRows.length,
         duplicates: Array.from(new Set(duplicates)).slice(0, 20),
         invalidRows
      },
      "O'quvchilar bulk qo'shildi"
   );
});

module.exports = {
   getGroups,
   createGroup,
   deleteGroup,
   updateGroup,
   bulkAddStudents
};
