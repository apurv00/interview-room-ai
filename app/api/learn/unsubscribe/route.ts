import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { verifyActionToken } from '@shared/services/signedActionToken'

export const dynamic = 'force-dynamic'

/**
 * Learn-email unsubscribe — retrofitted onto the signed-token flow the jobs
 * wave built (security fast-follow, 2026-07-15). The legacy contract
 * (?userId=<raw>&type=...) was an unauthenticated IDOR that MUTATED ON GET:
 * anyone holding a user id could unsubscribe them, and a mail client's
 * link-prefetch could do it by accident. No legacy links exist in the wild
 * (the digest was a no-op before it was hard-disabled), so this is a clean
 * break: signed tokens only, GET confirms, POST commits.
 */

const SCOPES: Record<string, { field: string; label: string }> = {
  'learn-digest': { field: 'emailPreferences.digest', label: 'digest emails' },
  'learn-reminders': { field: 'emailPreferences.reminders', label: 'practice reminders' },
}

const page = (inner: string) =>
  new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Email preferences</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#0f1419;">${inner}</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } }
  )

const invalidPage = () =>
  page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>
    <p style="color:#475569;font-size:14px;">You can manage all email preferences from your account settings.</p>`)

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const v = verifyActionToken(token, 'unsub')
  if (!v.ok || !SCOPES[v.payload.action]) return invalidPage()
  return page(`<h1 style="font-size:20px;">Stop ${SCOPES[v.payload.action].label}?</h1>
    <p style="color:#475569;font-size:14px;">One click and we stop. You can turn them back on from settings any time.</p>
    <form method="POST" action="/api/learn/unsubscribe?token=${encodeURIComponent(token)}">
      <button type="submit" style="background:#0f172a;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;">Unsubscribe</button>
    </form>`)
}

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const v = verifyActionToken(token, 'unsub')
  const scope = v.ok ? SCOPES[v.payload.action] : undefined
  if (!v.ok || !scope) return invalidPage()

  await connectDB()
  await User.updateOne({ _id: v.payload.uid }, { $set: { [scope.field]: false } })
  return page(`<h1 style="font-size:20px;">Done — you won't get ${scope.label} anymore</h1>
    <p style="color:#475569;font-size:14px;">Changed your mind later? Settings → Notifications.</p>`)
}
