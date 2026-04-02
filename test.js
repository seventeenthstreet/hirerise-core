const { supabase } = require("./supabaseClient");

async function test() {
  const { data, error } = await supabase
    .from("activity_logs")
    .select("*");

  console.log(data);
}

test();