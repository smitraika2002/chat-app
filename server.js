// server.js — the backend.
// Supabase now does the heavy lifting (accounts, database, real-time, photos),
// so this server just serves the app's files and tells the browser how to reach Supabase.

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// These come from Render → Environment (see README). The publishable key is safe to share with browsers.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️  SUPABASE_URL and SUPABASE_KEY are not set. Add them in Render → Environment.");
}

// The browser loads this small script to learn where Supabase is
app.get("/config.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-store");
  res.send(`window.CHAT_CONFIG = ${JSON.stringify({ url: SUPABASE_URL, key: SUPABASE_KEY })};`);
});

// Serve everything in the "public" folder (index.html, style.css, script.js, icons...)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
