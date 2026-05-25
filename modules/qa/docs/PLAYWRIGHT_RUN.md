# QA Agent v3 — Playwright Runner

---

## Auth setup (recommended: automation login)

Google OAuth **blocks Playwright's bundled Chromium**. Manual cookie paste works but does not scale for overnight runs.

**Use automation login** — one-time env setup, then every matrix run authenticates itself:

### 1. One-time configuration

**Vercel production** (Settings → Environment Variables):

| Variable | Value |
|----------|-------|
| `QA_AUTOMATION_ENABLED` | `true` |
| `QA_AUTOMATION_SECRET` | `openssl rand -hex 32` (same secret everywhere) |
| `QA_AUTOMATION_EMAIL` | Email of an existing QA user in MongoDB |

**Local `.env.local`** (same three vars + secret must match Vercel):

```bash
QA_AUTOMATION_ENABLED=true
QA_AUTOMATION_SECRET=your-shared-secret
QA_AUTOMATION_EMAIL=qa@yourdomain.com
```

Deploy after adding Vercel env vars so `/api/qa/automation-login` is live.

### 2. Verify (no browser, no cookie paste)

```bash
npm run qa:auth:automation:prod
npm run qa:auth:verify:prod
npm run qa:preflight:prod
```

### 3. Run matrix

```bash
npm run qa:v3:smoke:prod      # quick test
npm run qa:v3:matrix:prod     # full overnight
```

The runner calls `POST /api/qa/automation-login` at start, saves `modules/qa/.auth/prod-qa.json`, and reuses it until the 7-day session expires. **No manual steps per run.**

---

## Manual fallbacks (if automation not deployed yet)

### Import cookie from DevTools

1. Log in at https://www.interviewprep.guru in normal Chrome
2. F12 → Application → Cookies → `__Secure-next-auth.session-token` → copy Value
3. `npm run qa:auth:import:prod -- --token "PASTE"`

### Chrome CDP export

```bash
npm run qa:auth:cdp:prod
```

See earlier docs for CDP launch flags.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `QA automation login disabled` | Server flag off | `QA_AUTOMATION_ENABLED=true` on Vercel + redeploy |
| `401 Unauthorized` | Secret mismatch | Same `QA_AUTOMATION_SECRET` in `.env.local` and Vercel |
| `QA user not found` | Email not in MongoDB | Use account that exists in prod DB |
| Google "not secure" | OAuth in Playwright | Use automation login instead |
| Session expired | Cookie > 7 days | Re-run matrix — auto-refreshes if automation configured |
