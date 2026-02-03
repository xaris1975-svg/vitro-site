// server.js
// Render-friendly Express server: serves /public, provides /api/site (persisted JSON) and /api/contact (Brevo email)

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config ----
const PORT = process.env.PORT || 3000;

// Persistent disk dir (Render): set this env or mount path accordingly
const DATA_DIR =
  process.env.RENDER_DISK_PATH ||
  process.env.DATA_DIR ||
  "/var/data";

const SITE_DATA_FILE =
  process.env.SITE_DATA_FILE ||
  path.join(DATA_DIR, "site-data.json");

// Email (Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || "";
const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || "";
const CONTACT_FROM_NAME = process.env.CONTACT_FROM_NAME || "VITRO CANVAS";
const CONTACT_SUBJECT_PREFIX = process.env.CONTACT_SUBJECT_PREFIX || "Νέο μήνυμα από site";

// ---- Middleware ----
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Static site
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Health
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---- Helpers ----
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("[data] mkdir failed:", e);
  }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[data] read/parse failed:", e);
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.error("[data] write failed:", e);
    return false;
  }
}

// ---- API: site data (public reads, admin writes from your panel) ----
app.get("/api/site", (_req, res) => {
  const data = readJsonSafe(SITE_DATA_FILE, { ok: true, data: null });
  res.json(data);
});

app.post("/api/site", (req, res) => {
  // You can add auth here if you want; right now it just saves.
  const payload = req.body;
  const ok = writeJsonSafe(SITE_DATA_FILE, payload);

  console.log("[site] saved site-data.json", { ok, bytes: JSON.stringify(payload || {}).length });
  if (!ok) return res.status(500).json({ ok: false, error: "Failed to save" });

  res.json({ ok: true });
});

// ---- API: contact form ----
app.post("/api/contact", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const message = String(req.body?.message || "").trim();

    if (message.length < 3) {
      return res.status(400).json({ ok: false, error: "Λείπει μήνυμα." });
    }

    // Log so you ALWAYS see something in Render logs
    console.log("[contact] incoming", {
      name: name ? name.slice(0, 80) : "",
      email: email ? email.slice(0, 120) : "",
      messageLen: message.length
    });

    // If Brevo not configured, don't lie. Return 500 with clear error.
    if (!BREVO_API_KEY || !CONTACT_TO_EMAIL || !CONTACT_FROM_EMAIL) {
      console.error("[contact] missing env vars", {
        hasKey: Boolean(BREVO_API_KEY),
        hasTo: Boolean(CONTACT_TO_EMAIL),
        hasFrom: Boolean(CONTACT_FROM_EMAIL),
      });
      return res.status(500).json({
        ok: false,
        error:
          "Email δεν είναι ρυθμισμένο στο server (λείπουν BREVO_API_KEY / CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL)."
      });
    }

    const subject = `${CONTACT_SUBJECT_PREFIX} (${name || "χωρίς όνομα"})`;

    const textBody =
`Νέο μήνυμα από τη φόρμα επικοινωνίας:

Όνομα: ${name || "-"}
Email: ${email || "-"}
Μήνυμα:
${message}
`;

    // Send via Brevo Transactional Email API
    const brevoResp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: CONTACT_FROM_NAME, email: CONTACT_FROM_EMAIL },
        to: [{ email: CONTACT_TO_EMAIL }],
        replyTo: email ? { email, name: name || email } : undefined,
        subject,
        textContent: textBody
      })
    });

    const brevoJson = await brevoResp.json().catch(() => ({}));

    if (!brevoResp.ok) {
      console.error("[contact] brevo error", { status: brevoResp.status, brevoJson });
      return res.status(502).json({
        ok: false,
        error: "Brevo απέτυχε να στείλει email.",
        details: brevoJson
      });
    }

    console.log("[contact] sent ok", brevoJson);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[contact] server error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Fallback to index.html for single-page style setups (optional)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  console.log("[data] SITE_DATA_FILE =", SITE_DATA_FILE);
});
