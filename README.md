# Vitro site (Node/Express on Render)

- Public: /  (site/public/index.html)
- Admin: /admin/login.html -> /admin/index.html
- Data persist: DATA_DIR (default /var/data) (Render Disk)
- API: GET /api/site (public), POST /api/site (admin-only)

Env:
- ADMIN_USER / ADMIN_PASS
- (optional) SESSION_SECRET
- (optional) GEMINI_API_KEY
- (optional contact form) SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS CONTACT_TO_EMAIL
