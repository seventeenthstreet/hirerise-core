require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

async function test() {

  const { data, error } = await supabase
    .from("activity_logs")
    .select("*");

  console.log(data);
}

test();