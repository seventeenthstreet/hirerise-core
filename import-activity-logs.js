require("dotenv").config();

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const data = JSON.parse(fs.readFileSync("firestore-backup.json"));

function convertTimestamp(ts) {
  if (!ts || !ts._seconds) return null;
  return new Date(ts._seconds * 1000);
}

async function run() {

  const logs = Object.entries(data.activityLogs).map(([id, doc]) => ({
    id,
    action: doc.action,
    user_id: doc.userId,
    target_id: doc.targetId,
    metadata: doc.metadata,
    created_at: convertTimestamp(doc.timestamp)
  }));

  const { error } = await supabase
    .from("activity_logs")
    .insert(logs);

  if (error) console.error(error);
  else console.log("Activity logs imported successfully");
}

run();