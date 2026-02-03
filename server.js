import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import fsp from "fs/promises";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 10000;

// Admin login (from Render env)
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Email / SMTP (from Render env)
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const CONTACT_TO = process.env.CONTACT_TO || ""; // where contact form emails go
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || CONTACT_TO || "no-reply@example.com";

// Persistent data directory (Render Disk should be mounted here)
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const SITE_DATA_PATH = path.join(DATA_DIR, "site-data.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "vitro-session-" + Math.random().toString(36).slice(2);

// Resolve dirs safely (avoid URL pathname weirdness)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "site", "public");
const ADMIN_DIR = path.join(__dirname, "site", "admin");

// Parsers
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

async function ensureDirs() {
  try {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn("[warn] cannot create data dirs:", e?.message || e);
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
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SITE_DATA_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

// Kick off dir creation
ensureDirs();

// Sessions (cookie-based login). No Basic Auth popups, no Safari loops.
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // Render uses https
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
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// Static public
app.use("/", express.static(PUBLIC_DIR, { redirect: false }));

// Uploaded assets (served publicly)
app.use("/uploads", express.static(UPLOADS_DIR, { redirect: false }));

// Admin entry: always show login page
app.get("/admin", (req, res) => res.redirect("/admin/login.html"));
app.get("/admin/", (req, res) => res.redirect("/admin/login.html"));
app.get("/admin/login.html", (req, res) =>
  res.sendFile(path.join(ADMIN_DIR, "login.html"))
);

// Login / logout API
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authed = true;
    console.log("[auth] login ok");
    return res.json({ ok: true });
  }
  console.warn("[auth] login failed");
  return res.status(401).json({ ok: false, error: "Λάθος username ή password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
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
    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Missing data" });
    }

    // Guardrail: avoid giant JSON payloads (base64 images etc)
    const size = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (size > 18_000_000) {
      return res.status(413).json({
        ok: false,
        error: "Payload too large (reduce images or text)",
      });
    }

    const saved = await writeSiteData(data);
    console.log("[site] saved site-data.json", saved?._meta?.savedAt || "");
    return res.json({ ok: true, data: saved });
  } catch (e) {
    console.error("[site] save failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  const url = `/uploads/${encodeURIComponent(req.file.filename)}`;
  console.log("[upload]", url);
  return res.json({ ok: true, url });
});

/* ---------------- EMAIL ---------------- */

function getMailer() {
  // Validate config
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("Missing SMTP_HOST/SMTP_USER/SMTP_PASS on server.");
  }
  // Gmail on 587 => secure false + STARTTLS
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// Public contact endpoint (your site can call this)
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!CONTACT_TO) return res.status(500).json({ ok: false, error: "Missing CONTACT_TO on server." });
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Missing name/email/message" });
    }

    const transporter = getMailer();

    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to: CONTACT_TO,
      replyTo: email,
      subject: `Νέο μήνυμα από site: ${name}`,
      text: `Όνομα: ${name}\nEmail: ${email}\n\nΜήνυμα:\n${message}\n`,
    });

    console.log("[mail] contact sent:", info?.messageId || "(no id)");
    return res.json({ ok: true });
  } catch (e) {
    console.error("[mail] contact failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Admin-only test email (this is what σου έβγαζε "Cannot GET")
app.get("/api/admin/test-email", requireSessionApi, async (req, res) => {
  try {
    if (!CONTACT_TO) return res.status(500).json({ ok: false, error: "Missing CONTACT_TO on server." });

    const transporter = getMailer();
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to: CONTACT_TO,
      subject: "✅ Test email από vitro-site",
      text: `Test OK @ ${new Date().toISOString()}`,
    });

    console.log("[mail] test sent:", info?.messageId || "(no id)");
    return res.json({ ok: true, messageId: info?.messageId || null });
  } catch (e) {
    console.error("[mail] test failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------------- GEMINI ---------------- */
/**
 * Gemini proxy endpoints (admin-only)
 */
app.get("/api/gemini/models", requireSessionApi, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY on server." });
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url);
  const txt = await r.text();
  if (!r.ok) return res.status(r.status).json({ ok: false, error: txt });
  res.type("json").send(txt);
});

app.post("/api/gemini/generate", requireSessionApi, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY on server." });
    const model = req.body?.model || "gemini-2.5-flash";
    const body = req.body?.body;
    if (!body) return res.status(400).json({ ok: false, error: "Missing body payload." });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: txt });
    res.type("json").send(txt);
  } catch (e) {
    console.error("[gemini] error:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Basic health
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Public: http://localhost:${PORT}/`);
  console.log(`Admin login:  http://localhost:${PORT}/admin/login.html`);
});
