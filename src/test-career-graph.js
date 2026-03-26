const careerRepo = require("./repositories/career.repository");

// ----------------------------
// TEST 1: Get Current Role
// ----------------------------
const role = careerRepo.getRole("se_3");

if (!role) {
  console.error("❌ Role se_3 not found!");
  process.exit(1);
}

console.log("\n✅ Current Role:");
console.log(role);

// ----------------------------
// TEST 2: Get Next Roles
// ----------------------------
const nextRoles = careerRepo.getNextRoles("se_3");

console.log("\n✅ Next Roles:");

if (!nextRoles || nextRoles.length === 0) {
  console.log("No next roles found.");
} else {
  nextRoles.forEach((r, index) => {
    if (!r) {
      console.log(`→ Role at index ${index} is NULL (broken reference)`);
    } else {
      console.log("→", r.title, `(${r.role_id})`);
    }
  });
}

// ----------------------------
// EXTRA DEBUG (IMPORTANT)
// ----------------------------
console.log("\n🔎 Debug Check:");
console.log("tech_lead:", careerRepo.getRole("tech_lead"));
console.log("engineering_manager:", careerRepo.getRole("engineering_manager"));









