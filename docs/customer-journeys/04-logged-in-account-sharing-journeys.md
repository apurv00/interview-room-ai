# Logged-In Account, Sharing & Misc Journeys

Everything an authenticated user can do outside the interview engine, resume tools, and Learn module: **settings**, **profile**, **plan/billing**, **data export**, **account deletion**, **sharing** (scorecard links + social), **waitlist**, **legal**, and **navigation utilities**.

Core interview flows → `02-*.md`. Resume + Learn → `03-*.md`.

---

## 1. Settings (`/settings`)

Tab-based account center.

### 1.1 Tabs

| Tab | What's there |
|-----|-------------|
| Profile | Name, title, industry, experience, target roles, target companies, skills, LinkedIn URL, timeline |
| Account | Email (read-only), linked OAuth providers (Google/GitHub), change password (credentials users only), theme toggle |
| Notifications | Weekly email digest, streak reminders, feature updates, product emails |
| Billing & Plan | Current plan, usage this month, upgrade/downgrade, payment method, invoices |
| Privacy & Data | Session data export, delete account |
| Preferences | Default domain, default depth, avatar voice, coaching intensity |

### 1.2 Profile tab

- Fields mirror onboarding (see `02-*.md §1.2`).
- **"Save changes"** → `PUT /api/user/profile` → toast "Saved".
- **"Discard"** → resets.
- Changes propagate to the resume builder's "Import from Profile" and pathway generation.

### 1.3 Account tab

- **Linked providers**: shows which OAuth accounts are linked to the user. **"Link Google"** / **"Link GitHub"** → OAuth flow → account linking via NextAuth (requires matching email or confirmation).
- **"Unlink"** → prevents unlinking the only remaining provider.
- **Theme toggle**: Light / Dark / System → persisted in `User.preferences.theme`.
- **Language** (if i18n enabled) → currently English-only placeholder.

### 1.4 Notifications tab

- Toggles → `PUT /api/user/notifications`.
- **"Send test email"** → triggers an email digest preview.
- **"Unsubscribe all"** → one-click disables everything.

### 1.5 Billing & Plan tab

#### 1.5.1 Plan display

- Current plan badge: **Free** / **Pro** / **Enterprise**.
- Usage bar: "{n} of {limit} interviews this month".
- Renewal date.
- Next invoice amount (Pro/Enterprise).

#### 1.5.2 Upgrade flow (Free → Pro)

- **"Upgrade to Pro"** → `POST /api/billing/checkout` → Stripe Checkout session → redirect to Stripe.
- On Stripe success → `/settings/billing/success?session_id=...` → `POST /api/billing/verify` → user.plan set → toast "You're Pro!" + confetti.
- On cancel → `/settings/billing/cancel` → back to billing tab.

#### 1.5.3 Manage subscription (Pro)

- **"Manage subscription"** → `POST /api/billing/portal` → Stripe Customer Portal → user can update card, cancel, view invoices.
- **"Cancel plan"** → opens Stripe portal cancel flow → on cancel, webhook downgrades user at period end.
- **"Reactivate"** → Stripe portal.

#### 1.5.4 Invoices

- List of invoices from Stripe → each row has **"Download PDF"** (Stripe-hosted link).

#### 1.5.5 Enterprise

- **"Contact sales"** → `mailto:sales@interviewprep.guru` (no self-serve upgrade).

### 1.6 Privacy & Data tab

#### 1.6.1 Data export

- **"Export my data"** → `POST /api/user/export` → Inngest job bundles JSON + CSV → email with download link (7-day TTL).
- Status pill: "Pending" / "Ready" / "Expired".
- **"Re-request"** after TTL expires.

#### 1.6.2 Delete interview history

- **"Delete all sessions"** → double-confirm modal → `DELETE /api/user/sessions` → irreversible.

#### 1.6.3 Delete account

- **"Delete my account"** → triple-confirm (type "DELETE") → `POST /api/user/delete`:
  - Marks `User.deletedAt`.
  - Cancels Stripe subscription.
  - Revokes all scorecard share tokens.
  - Schedules purge via Inngest (30-day grace).
  - Signs the user out.
  - Redirects to `/` with farewell banner.
- During grace period, re-signing in restores the account with a "Welcome back" banner.

### 1.7 Preferences tab

- **Default domain / depth / duration** → prefills setup.
- **Avatar voice** → picks one of the Deepgram Aura voices → preview playback button.
- **Coaching intensity** → Low / Medium / High (controls frequency of nudges).
- **Autoplay replays** → toggle.
- **"Reset to defaults"** → confirmation → wipes preferences.

### 1.8 Settings errors

- `PUT /api/user/profile` 400 → per-field inline errors.
- Stripe portal 5xx → "Couldn't reach billing — try again" toast + retry.
- OAuth link collision (email already on another account) → inline error + support link.

---

## 2. Usage & Quota

Rendered in-app via `UsageBadge`, `UsageMeter`, and `UsageLimitModal`.

### 2.1 Where it's visible

- Top nav (compact): "{used}/{limit}".
- Interview setup page: full usage bar.
- Settings > Billing: full usage bar.
- Feedback page: "You have X interviews left this month".

### 2.2 Quota gates

| Action | Free | Pro | Enterprise |
|--------|------|-----|-----------|
| Interviews/month | 3 | 30 | Unlimited |
| Multimodal replays/month | 1 | 10 | Unlimited |
| Saved resumes | 3 | 3 | 10 |
| Drill sessions/week | 1 | Unlimited | Unlimited |
| Pathway regeneration | Monthly auto | Weekly manual | Unlimited |
| Streak freeze tokens | 0 | 2/month | Unlimited |
| Data export | 1/month | 4/month | Unlimited |

### 2.3 Quota exceeded

- All exceed paths route through `UsageLimitModal`:
  - Title: "You've hit your monthly limit"
  - **"Upgrade to Pro"** → Stripe checkout
  - **"Not now"** → close

---

## 3. Upgrade Prompts (cross-app)

Upgrade CTAs appear in many places:

- Homepage pricing block.
- Settings > Billing.
- Quota-gated actions (setup, replay, drill).
- Feedback page coaching block (for Pro-only insights).
- Resume AI actions on the 4th usage (Pro unlock hint).
- Streak freeze prompt on streak break.

All lead to either:
- `/pricing`
- Stripe Checkout (`POST /api/billing/checkout`)
- Stripe portal (`POST /api/billing/portal`)

---

## 4. Profile Menu (AppShell, authenticated)

Top-right avatar dropdown:

| Item | Target |
|------|--------|
| Avatar + name header | — |
| **"Dashboard"** | `/dashboard` |
| **"Profile"** | `/settings` (profile tab) |
| **"Billing"** | `/settings?tab=billing` |
| **"History"** | `/history` |
| **"Progress"** | `/learn/progress` |
| **"Badges"** | `/learn/badges` |
| **"Help & feedback"** | Opens `mailto:support@interviewprep.guru` |
| **"Sign out"** | `signOut({ callbackUrl: '/' })` |

Plan badge (Free/Pro/Enterprise) shown in the header.

---

## 5. Sharing

### 5.1 Public scorecard (generate)

Entry points:
- Feedback page → **"Share scorecard"**
- History row → **"Share"**
- Progress page → **"Share progress"**

Modal (`ShareScorecardModal`):
1. Preview of the public scorecard card.
2. Visibility toggle: include overall score / include dimensions / include strengths.
3. **"Generate link"** → `POST /api/learn/share` → returns token + URL.
4. URL rendered with copy button.
5. **"Revoke link"** → `DELETE /api/learn/share/[token]` → invalidates immediately.
6. **"Share to LinkedIn"** → opens LinkedIn share prompt with prefilled URL + copy.
7. **"Share to X/Twitter"** → opens Twitter Intent URL with prefilled text + link.
8. **"Copy"** → clipboard + toast.

Tokens expire after 90 days. Revocation and expiry both cause `/scorecard/[token]` to show "expired or revoked" state.

### 5.2 Public scorecard (consume)

See `01-*.md §10`. A token holder (possibly the same user) can open `/scorecard/[token]` anonymously — no auth required.

### 5.3 Badge sharing

From `/learn/badges`:
- Click a badge → modal → **"Share badge"** → `ShareBadgeModal`:
  - Generates social card image.
  - LinkedIn + X prefill.
  - Copy link (points to homepage with tracking param).

### 5.4 Progress / pathway sharing

From `/learn/progress` or `/learn/pathway`:
- **"Share progress"** → generates an aggregate scorecard (no individual sessions).
- Same modal flow as §5.1.

### 5.5 Interview-complete celebration share

After first-ever interview, a celebration modal shows:
- Score ring
- **"Share this win"** → `ShareScorecardModal` pre-opened.
- **"Maybe later"** → close.

---

## 6. Waitlist (`/api/waitlist`)

- Visible on homepage and pricing page (Pro plan card).
- Form: email input + **"Notify Me"**.
- `POST /api/waitlist` → stores email in `Waitlist` collection (rate-limited by IP).
- Success: inline "You're on the list!" + confetti.
- Error: duplicate email returns 200 with same success message (idempotent).
- Invalid email: inline validation error.

---

## 7. Legal & Static Pages (authenticated)

Same routes as anonymous (see `01-*.md §5`):
- `/privacy` — same content, footer shows authenticated nav.
- `/terms` — same.
- `/pricing` — authenticated users see their current plan highlighted; **"Your plan"** badge replaces **"Get Started Free"** on their row.
- `/resources` → `/learn/guides` — authenticated users see read/unread indicators.

---

## 8. Notifications & Email (outbound, not user-initiated but user-visible)

Daily email digest (`emailDigestJob`, Inngest 9 AM UTC):
- Sent only to users with `notifications.weeklyDigest = true`.
- Contents: streak status, pathway next step, leaderboard rank change, new guides, upgrade CTA.
- Each email link carries a signed token → lands user on `/dashboard` already signed in (magic-link-lite).

Product emails (marketing launches) gated by `notifications.productEmails`.

---

## 9. Utility Journeys

### 9.1 Sign out

- Profile menu → **"Sign out"** → `signOut({ callbackUrl: '/' })` → cookies cleared → redirect home.
- Idle-timeout auto sign-out: none (session long-lived via NextAuth JWT).

### 9.2 Session resumption

- JWT-based session persists across browser restarts (~30 days).
- Silent refresh on any page load.

### 9.3 Multi-tab consistency

- `BroadcastChannel` (or storage events) keeps live AppShell state (XP, plan) in sync across tabs.
- A sign-out in one tab signs out all tabs.

### 9.4 404 / error pages

- Global `app/not-found.tsx` → **"Back to home"** → `/`.
- Route-segment error boundaries → **"Try again"** → refresh + **"Home"** → `/`.

### 9.5 Keyboard shortcuts

In the interview page:
- `Space` → skip/advance
- `M` → mute/unmute
- `R` → repeat question
- `Esc` → opens end-interview confirm

In the replay page:
- `Space` → play/pause
- `←` / `→` → seek ±5 s
- `1`..`4` → playback speed

### 9.6 Accessibility

- All CTAs have aria-labels.
- Skip-to-content link on every layout.
- Reduced-motion preference honored on homepage fold animations.
- Focus-trap on modals (auth gate, share, usage limit).

---

## 10. Dead-End / Redirect Journeys (Logged In)

| Starting point | Action | Outcome |
|----------------|--------|---------|
| `/onboarding` after completion | none | `router.replace('/')` |
| `/signin` while authenticated | none | `router.replace('/')` |
| `/signup` while authenticated | none | `router.replace('/')` |
| `/hire/*` as candidate | none | 403 or redirect (out of scope) |
| `/cms/*` as candidate | none | 403 (out of scope) |
| `/feedback/[id]` for other user's session | none | 403 + redirect to `/history` |
| `/replay/[sessionId]` | any | 301 → `/feedback/[sessionId]` |
| Quota exhausted → retry | any | `UsageLimitModal` |
| Account pending deletion | sign in | "Welcome back" restore banner |

---

## 11. Global Navigation Map (Authenticated)

```
AppShell Header
├── Logo → /
├── Interview → /interview/setup
├── Resume → /resume
├── History → /history
├── Progress → /learn/progress
├── Resources → /learn/guides
├── Pricing → /pricing
├── XpBadge → /learn/progress
└── Profile menu
    ├── Dashboard → /dashboard
    ├── Profile → /settings
    ├── Billing → /settings?tab=billing
    ├── History → /history
    ├── Progress → /learn/progress
    ├── Badges → /learn/badges
    ├── Help & feedback → mailto:support@
    └── Sign out → / (post sign-out)

Footer (same on every page)
├── Product: Home, Interview, Pricing, Resources, Get Started
├── Tools: Resume Builder, Tailor, ATS, Templates, For Recruiters
├── Topic Hubs: Behavioral, Company Guides, Interview Types
├── Interview Questions: 5 pillar guide links
├── Tips & Frameworks: 6 guide links
└── Legal row: Privacy, Terms, Contact, Sign in
```
