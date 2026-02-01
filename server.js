import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import fsp from "fs/promises";

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Persistent data directory (Render Disk should be mounted here)
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const SITE_DATA_PATH = path.join(DATA_DIR, "site-data.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

const SESSION_SECRET = process.env.SESSION_SECRET || "vitro-session-" + Math.random().toString(36).slice(2);

const PUBLIC_DIR = new URL("./site/public", import.meta.url).pathname;
const ADMIN_DIR = new URL("./site/admin", import.meta.url).pathname;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));


async function ensureDirs() {
  try {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  } catch (e) {
    console.warn("[warn] cannot create uploads dir:", e?.message || e);
  }
}

async function readSiteData() {
  try {
    const raw = await fsp.readFile(SITE_DATA_PATH, "utf8");
    const json = JSON.parse(raw);
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

async function writeSiteData(data) {
  const payload = {
    ...data,
    _meta: { savedAt: new Date().toISOString() },
  };
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(SITE_DATA_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    console.warn("[warn] cannot write site data:", e?.message || e);
    throw e;
  }
  return payload;
}

// Kick off directory creation (non-blocking)
ensureDirs();

app.set("trust proxy", 1);

// Sessions (cookie-based login). No Basic Auth popups, no Safari loops.
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12, // 12h
    },
  })
);

function isAuthed(req) {
  return Boolean(req.session && req.session.authed);
}

function requireSession(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect("/admin/login.html");
}

function requireSessionApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Public site
app.use("/", express.static(PUBLIC_DIR, { redirect: false }));

// Uploaded assets (served publicly)
app.use("/uploads", express.static(UPLOADS_DIR, { redirect: false }));

// Serve uploaded assets publicly
app.use("/uploads", express.static(UPLOADS_DIR, { redirect: false }));

// Admin entry: always show login page (no auth popups)
app.get("/admin", (req, res) => res.redirect("/admin/login.html"));
app.get("/admin/", (req, res) => res.redirect("/admin/login.html"));
app.get("/admin/login.html", (req, res) => res.sendFile(ADMIN_DIR + "/login.html"));

// Login / logout API
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Λάθος username ή password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// Protect all admin assets/pages except login.html
app.use("/admin", requireSession, express.static(ADMIN_DIR, { redirect: false }));

/**
 * CMS Site Data
 * - GET is public (the website loads content from the server)
 * - POST is admin-only (admin saves content to Render Disk)
 */
app.get("/api/site", async (req, res) => {
  const data = await readSiteData();
  return res.json({ ok: true, data: data || null });
});

app.post("/api/site", requireSessionApi, async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data || typeof data !== "object") return res.status(400).json({ error: "Missing data" });
    // Guardrail: images should be uploaded as files, not base64 in JSON
    const size = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (size > 2_000_000) return res.status(413).json({ error: "Payload too large" });
    const saved = await writeSiteData(data);
    return res.json({ ok: true, data: saved });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Image upload (admin-only). Returns {url} under /uploads/...
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await ensureDirs();
        cb(null, UPLOADS_DIR);
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => {
      const safeBase = (file.originalname || "upload")
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .slice(0, 80);
      const ext = path.extname(safeBase) || ".bin";
      const name = path.basename(safeBase, ext) || "file";
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("Only image uploads are allowed"));
  },
});

app.post("/api/upload", requireSessionApi, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const url = `/uploads/${encodeURIComponent(req.file.filename)}`;
  return res.json({ ok: true, url });
});

/**
 * Gemini proxy endpoints (admin-only)
 * Docs: https://ai.google.dev/api (models & generateContent)
 */
app.get("/api/gemini/models", requireSessionApi, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "Missing GEMINI_API_KEY on server." });
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url);
  const txt = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: txt });
  res.type("json").send(txt);
});

app.post("/api/gemini/generate", requireSessionApi, async (req, res) => {
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
  console.log(`Admin login:  http://localhost:${PORT}/admin/login.html`);
});
