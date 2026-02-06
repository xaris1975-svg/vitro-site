# VITRO site (production-ish split)

## What you get
- Public site: / (no admin UI, lighter)
- Admin site: /admin (protected with Basic Auth)
- Gemini AI calls go through the server so the API key is not exposed.

## Run locally
1) Install Node.js 18+
2) In this folder:
   npm install
3) Set environment variables (Mac/Linux):
   export ADMIN_USER="admin"
   export ADMIN_PASS="your-strong-password"
   export GEMINI_API_KEY="YOUR_GEMINI_KEY"
4) Start:
   npm start
5) Open:
   http://localhost:3000/
   http://localhost:3000/admin

## Deploy
Deploy this Node app to any host that supports Node (Render, Fly.io, Railway, VPS).
Then point your domain to it.


Extra env (optional): COOKIE_DOMAIN=.vitrocanvas.gr
