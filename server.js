import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import fsp from "fs/promises";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "vitro-session-" + Math.random().toString(36).slice(2);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

if (!ADMIN_USER || !ADMIN_PASS) {
  console.warn("[WARN] ADMIN_USER / ADMIN_PASS are not set. Admin login will fail until you set them in Render → Environment and redeploy.");
}

// Persistent data directory (mount a Render Disk here)
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const SITE_DATA_PATH = path.join(DATA_DIR, "site-data.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// Email (SMTP)
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const CONTACT_TO = process.env.CONTACT_TO || "";
const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || SMTP_USER;

// ===== Paths to static folders in repo =====
const PUBLIC_DIR = new URL("./site/public", import.meta.url).pathname;
const ADMIN_DIR = new URL("./site/admin", import.meta.url).pathname;

// ===== Middleware =====
app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.use(
  session({
    name: "vitro_admin",
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

function requireSessionApi(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// Basic in-memory rate limit for /api/contact (good enough for now)
const contactHits = new Map();
function contactRateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const windowMs = 60_000; // 1 min
  const max = 10;
  const entry = contactHits.get(ip) || { count: 0, ts: now };
  if (now - entry.ts > windowMs) {
    entry.count = 0;
    entry.ts = now;
  }
  entry.count++;
  contactHits.set(ip, entry);
  if (entry.count > max) return res.status(429).json({ ok: false, error: "Too many requests" });
  next();
}

async function ensureDirs() {
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

async function readSiteData() {
  try {
    const raw = await fsp.readFile(SITE_DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeSiteData(data) {
  await ensureDirs();
  await fsp.writeFile(SITE_DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function getMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !CONTACT_TO) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// ===== Static serving =====
app.use("/uploads", express.static(UPLOADS_DIR));

// Protect /admin (except the login page)
app.use("/admin", (req, res, next) => {
  const openPaths = new Set(["/login.html", "/login", "/assets"]); // allow login + assets
  const p = req.path;
  if (openPaths.has(p) || p.startsWith("/assets")) return next();
  if (!isAuthed(req)) return res.redirect("/admin/login.html");
  next();
});
app.use("/admin", express.static(ADMIN_DIR));

// Public site
app.use(express.static(PUBLIC_DIR));

// ===== Admin auth =====
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  console.log(`[ADMIN LOGIN] attempt username="${username || ""}" hasPass=${Boolean(password)} envSet=${Boolean(ADMIN_USER && ADMIN_PASS)}`);
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Wrong credentials" });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/me", (req, res) => {
  res.json({ ok: true, authed: isAuthed(req) });
});

// ===== Site data API =====
app.get("/api/site", async (req, res) => {
  const data = await readSiteData();
  res.json({ ok: true, data: data || {} });
});

app.post("/api/site", requireSessionApi, async (req, res) => {
  try {
    await writeSiteData(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Uploads (optional) =====
const upload = multer({ dest: UPLOADS_DIR });
app.post("/api/upload", requireSessionApi, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });
    // Keep original extension if possible
    const ext = path.extname(req.file.originalname || "");
    const newName = req.file.filename + ext;
    const newPath = path.join(UPLOADS_DIR, newName);
    await fsp.rename(req.file.path, newPath);
    res.json({ ok: true, url: `/uploads/${newName}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Contact form =====
app.post("/api/contact", contactRateLimit, async (req, res) => {
  try {
    // Accept JSON or normal form posts
    const name = (req.body?.name || "").toString().trim();
    const email = (req.body?.email || "").toString().trim();
    const phone = (req.body?.phone || "").toString().trim();
    const message = (req.body?.message || "").toString().trim();

    // Honeypot (optional): if a bot fills it, drop silently
    const website = (req.body?.website || "").toString().trim();
    if (website) return res.json({ ok: true });

    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Missing name/email/message" });
    }

    const transporter = getMailer();
    if (!transporter) {
      return res.status(500).json({
        ok: false,
        error:
          "Email is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/CONTACT_TO in Render.",
      });
    }

    const subject = `Νέο μήνυμα από φόρμα (${name})`;
    const text = [
      `Όνομα: ${name}`,
      `Email: ${email}`,
      phone ? `Τηλέφωνο: ${phone}` : null,
      "",
      message,
    ]
      .filter(Boolean)
      .join("\n");

    const info = await transporter.sendMail({
      from: CONTACT_FROM_EMAIL,
      to: CONTACT_TO,
      replyTo: email,
      subject,
      text,
    });

    console.log("[contact] email sent:", info.messageId);
    res.json({ ok: true });
  } catch (e) {
    console.error("[contact] send failed:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Admin test email (easy browser test) =====
app.get("/api/admin/test-email", requireSessionApi, async (req, res) => {
  try {
    const transporter = getMailer();
    if (!transporter) {
      return res.status(500).json({
        ok: false,
        error:
          "Email is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/CONTACT_TO in Render.",
      });
    }

    const info = await transporter.sendMail({
      from: CONTACT_FROM_EMAIL,
      to: CONTACT_TO,
      subject: "Vitro: test email ✅",
      text: "Αν το βλέπεις αυτό, το SMTP δουλεύει.",
    });

    console.log("[test-email] sent:", info.messageId);
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error("[test-email] failed:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Gemini proxy (optional) =====
app.get("/api/gemini/models", requireSessionApi, async (req, res) => {
  try {
    if (!GEMINI_API_KEY)
      return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;
    const r = await fetch(url);
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: txt });
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/gemini/generate", requireSessionApi, async (req, res) => {
  try {
    if (!GEMINI_API_KEY)
      return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY" });

    const model = req.body?.model || "gemini-2.5-flash";
    const body = req.body?.body;
    if (!body) return res.status(400).json({ ok: false, error: "Missing body payload" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: txt });
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Public: http://localhost:${PORT}/`);
  console.log(`Admin login: http://localhost:${PORT}/admin/login.html`);
});
