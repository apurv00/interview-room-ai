# Interview Prep Guru — Customer Journey Map

This directory documents every user journey across every CTA and page in the Interview Prep Guru consumer product (B2B `/hire/*` routes are **excluded**).

The goal is exhaustive coverage: if a user can click it, tap it, or land on it, it should be documented here.

## Files

| File | Contents |
|------|----------|
| `01-logged-out-journeys.md` | Every journey a **not-signed-in** visitor can take — marketing, auth, public browsing, anonymous resume tools, public scorecards, legal/pricing, auth-gated dead-ends. |
| `02-logged-in-interview-journeys.md` | Authenticated journeys for the **core interview product**: onboarding → setup → lobby → interview → feedback → history, including multimodal replay, drill mode, and error/limit paths. |
| `03-logged-in-resume-learn-journeys.md` | Authenticated **resume builder**, **resume wizard**, **tailor**, **ATS check**, **templates**, and the full **Learn module** (guides, practice sets, progress, pathway, dashboard, badges, daily challenge, streaks, XP/levels). |
| `04-logged-in-account-sharing-journeys.md` | Account/**settings**, profile editing, usage/billing, plan upgrades, data export, account deletion, **public scorecard sharing**, social share (LinkedIn/X), **waitlist**, legal pages, and navigation utilities. |

## Conventions

- `Arrow →` represents navigation (SPA route or modal).
- `[Auth Gate]` = anonymous users hit a modal or are redirected.
- `[Quota Gate]` = free plan limit may block the action.
- `[Feature Flag]` = gated by an environment flag.
- CTA labels are in **"quotes and bold"** when they appear verbatim in the UI.
- Routes use the same path format the user sees in their URL bar.

## Out of scope (intentionally omitted)

- `/hire/*` pages and `/api/hire/*` routes (B2B recruiter product)
- `/cms/*` platform-admin screens (not consumer-facing)
- Inngest background jobs (not user-visible)
- Internal debug/seed endpoints
