require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
// Node 20 has no native global WebSocket — required by RealtimeClient at
// construction time even when realtime isn't used. Matches the pattern
// used elsewhere in the repo (see src/modules/dev/dev.controller.js).
const WebSocket = require("ws");

async function test() {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      {
        realtime: {
          transport: WebSocket,
        },
      }
    );

    const { data, error } = await supabase
      .from("activity_logs")
      .select("*");

    if (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({ ok: true, rows: Array.isArray(data) ? data.length : 0 }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  }
}

test();
