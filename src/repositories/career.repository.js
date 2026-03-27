const fs = require("fs");
const path = require("path");

const BASE_PATH = path.join(__dirname, "../data/career-graph");

function loadAllRoles() {
  console.log("Loading roles from:", BASE_PATH);

  const families = fs.readdirSync(BASE_PATH);
  let roles = {};

  families.forEach((family) => {
    const familyPath = path.join(BASE_PATH, family);

    // Skip non-directories
    if (!fs.statSync(familyPath).isDirectory()) {
      console.log("Skipping non-directory:", familyPath);
      return;
    }

    console.log("Reading family folder:", familyPath);

    const files = fs.readdirSync(familyPath);

    files.forEach((file) => {
      const filePath = path.join(familyPath, file);

      // Optional: skip non-JSON files (extra safety)
      if (!file.endsWith(".json")) {
        console.log("Skipping non-JSON file:", filePath);
        return;
      }

      try {
        console.log("Loading file:", filePath);

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        if (!data.role_id) {
          console.warn("⚠️ Missing role_id in:", filePath);
          return;
        }

        console.log("Loaded role_id:", data.role_id);

        roles[data.role_id] = data;
      } catch (err) {
        console.error("❌ Error reading file:", filePath, err.message);
      }
    });
  });

  console.log("✅ Career graph fully loaded");

  return roles;
}

// Load once at startup
const roleCache = loadAllRoles();

function getRole(roleId) {
  return roleCache[roleId] || null;
}

function getNextRoles(roleId) {
  const role = getRole(roleId);
  if (!role || !Array.isArray(role.next_roles)) return [];

  return role.next_roles
    .map((id) => getRole(id))
    .filter(Boolean); // remove nulls
}

module.exports = {
  getRole,
  getNextRoles,
};