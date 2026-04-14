'use strict';

require("dotenv").config();

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

// ✅ SERVICE ROLE KEY
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── LOAD DATA ─────────────────────────────────────────────────────────

const raw = fs.readFileSync("firestore-backup.json", "utf-8");
const data = JSON.parse(raw);

// ─── HELPERS ───────────────────────────────────────────────────────────

function convertTimestamp(ts) {
  if (!ts || !ts._seconds) return null;
  return new Date(ts._seconds * 1000).toISOString();
}

function safe(val, fallback = null) {
  return val ?? fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── CONFIG ────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;

// ─── INSERT WITH RETRY ─────────────────────────────────────────────────

async function insertBatchWithRetry(rows, batchIndex, totalBatches) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { error } = await supabase
        .from("activity_logs")
        .upsert(rows, { onConflict: 'id' });

      if (!error) {
        console.log(`✅ Batch ${batchIndex}/${totalBatches} success (${rows.length} rows)`);
        return true;
      }

      console.error(`❌ Batch ${batchIndex} attempt ${attempt} failed:`, error.message);

    } catch (err) {
      console.error(`💥 Batch ${batchIndex} attempt ${attempt} crashed:`, err.message);
    }

    // ⏱️ Exponential backoff (500ms → 1000ms → 2000ms)
    const delay = 500 * Math.pow(2, attempt - 1);
    console.log(`⏳ Retrying batch ${batchIndex} in ${delay}ms...`);
    await sleep(delay);
  }

  console.error(`🚫 Batch ${batchIndex} permanently failed after ${MAX_RETRIES} attempts`);
  return false;
}

// ─── MAIN RUNNER ───────────────────────────────────────────────────────

async function run() {
  if (!data.activityLogs) {
    console.error("❌ No activityLogs found in JSON");
    return;
  }

  const logs = Object.entries(data.activityLogs).map(([id, doc]) => ({
    id,
    action: safe(doc.action, "unknown"),
    user_id: safe(doc.userId),
    target_id: safe(doc.targetId),
    metadata: safe(doc.metadata, {}),
    created_at: convertTimestamp(doc.timestamp),
  }));

  const total = logs.length;
  const totalBatches = Math.ceil(total / BATCH_SIZE);

  console.log(`📦 Total logs: ${total}`);
  console.log(`📊 Total batches: ${totalBatches}`);

  let successCount = 0;
  let failedCount = 0;

  // ── Batch processing ────────────────────────────────────────────────
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = logs.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;

    const success = await insertBatchWithRetry(batch, batchIndex, totalBatches);

    if (success) successCount += batch.length;
    else failedCount += batch.length;

    // 📊 Progress tracking
    const processed = Math.min(i + BATCH_SIZE, total);
    const percent = ((processed / total) * 100).toFixed(2);

    console.log(`📈 Progress: ${processed}/${total} (${percent}%)`);
  }

  // ── FINAL SUMMARY ───────────────────────────────────────────────────
  console.log("\n🎉 Migration complete");
  console.log("────────────────────────────");
  console.log(`✅ Success rows: ${successCount}`);
  console.log(`❌ Failed rows: ${failedCount}`);
  console.log(`📦 Total rows:  ${total}`);
}

// ─── RUN ──────────────────────────────────────────────────────────────

run().catch(err => {
  console.error("❌ Migration failed:", err.message);
});