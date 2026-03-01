const fs = require("fs");
const path = require("path");

const BASE_PATH = path.join(__dirname, "../data/career-graph");

function loadAllRoles() {
  console.log("Loading roles from:", BASE_PATH);

  const families = fs.readdirSync(BASE_PATH);
  let roles = {};

  families.forEach((family) => {
    const familyPath = path.join(BASE_PATH, family);

    if (!fs.statSync(familyPath).isDirectory()) {
      console.log("Skipping non-directory:", familyPath);
      return;
    }

    console.log("Reading family folder:", familyPath);

    const files = fs.readdirSync(familyPath);

    files.forEach((file) => {
      const filePath = path.join(familyPath, file);
      console.log("Loading file:", filePath);

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      console.log("Loaded role_id:", data.role_id);

      roles[data.role_id] = data;
    });
  });

  return roles;
}

const roleCache = loadAllRoles();

function getRole(roleId) {
  return roleCache[roleId] || null;
}

function getNextRoles(roleId) {
  const role = getRole(roleId);
  if (!role) return [];

  return role.next_roles.map((id) => getRole(id));
}

module.exports = {
  getRole,
  getNextRoles
};