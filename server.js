
import express from "express";
import basicAuth from "basic-auth";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(express.json({ limit: "1mb" }));

function requireAdmin(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Area"');
    return res.status(401).send("Auth required");
  }
  next();
}

// Public site
app.use("/", express.static(new URL("./site/public", import.meta.url).pathname));

// Admin site (basic auth)
app.use("/admin", requireAdmin, express.static(new URL("./site/admin", import.meta.url).pathname));

/**
 * Gemini proxy endpoints (admin-only)
 * Docs: https://ai.google.dev/api (models & generateContent)
 */
app.get("/api/gemini/models", requireAdmin, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "Missing GEMINI_API_KEY on server." });
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url);
  const txt = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: txt });
  res.type("json").send(txt);
});

app.post("/api/gemini/generate", requireAdmin, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Missing GEMINI_API_KEY on server." });
    const model = req.body?.model || "gemini-2.5-flash";
    const body = req.body?.body;
    if (!body) return res.status(400).json({ error: "Missing body payload." });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: txt });
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Public: http://localhost:${PORT}/`);
  console.log(`Admin:  http://localhost:${PORT}/admin (Basic Auth)`);
});
