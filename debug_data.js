const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });
const User = require('./src/models/User');
const Group = require('./src/models/Group');
const Student = require('./src/models/Student');
const CoddyAttendance = require('./src/coddyCheck/models/CoddyAttendance');

async function run() {
   await mongoose.connect(process.env.MONGO_URI);

   const users = await User.find({ role: { $in: ['mentor', 'ta', 'mentor_ta'] } }, 'fullName role');
   const userNames = users.map(u => u.fullName.toLowerCase());
   console.log('--- USERS ---');
   console.log(users);

   const groups = await Group.find({}, 'name mentor');
   const groupMentors = [...new Set(groups.map(g => g.mentor))];
   console.log('\n--- UNIQUE GROUP MENTORS ---');
   console.log(groupMentors);

   const missingInGroups = groupMentors.filter(m => m && !userNames.includes(m.toLowerCase()));
   console.log('\nGroup Mentors NOT in Users list:', missingInGroups);

   const botMentorsAgg = await CoddyAttendance.aggregate([
      { $group: { _id: "$mainTeacher" } }
   ]);
   const botMentors = botMentorsAgg.map(m => m._id);
   console.log('\n--- UNIQUE BOT MENTORS (mainTeacher) ---');
   console.log(botMentors);

   const missingInBot = botMentors.filter(m => m && !userNames.includes(m.toLowerCase()));
   console.log('\nBot Mentors NOT in Users list:', missingInBot);

   const studentWithGroup = await Student.findOne({ groupId: { $exists: true, $ne: null } });
   console.log('\n--- SAMPLE STUDENT WITH GROUP ---');
   console.log(studentWithGroup);

   if (studentWithGroup && studentWithGroup.groupId) {
      const grp = await Group.findById(studentWithGroup.groupId);
      console.log('Linked Group:', grp);
   }

   process.exit(0);
}

run().catch(err => {
   console.error(err);
   process.exit(1);
});
