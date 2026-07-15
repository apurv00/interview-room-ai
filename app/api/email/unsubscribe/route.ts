import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { verifyActionToken } from '@shared/services/signedActionToken'

export const dynamic = 'force-dynamic'

/**
 * Human unsubscribe flow (EMAILS.md §3): the footer link. GET renders a
 * minimal confirm page (crawlers and link-scanners must never mutate
 * state); POST commits. Hardening: no external subresources, no personal
 * data rendered, Referrer-Policy: no-referrer (the token travels in the
 * URL — it must not leak via Referer). The RFC 8058 one-click path is a
 * SEPARATE endpoint (./one-click) — mail clients are robots and get no UI.
 */

const STREAMS = new Set(['e0', 'e1', 'e2', 'e3', 'e4', 'all'])

const page = (inner: string) =>
  new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Email preferences</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#0f172a;">${inner}</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } }
  )

function describeScope(scope: string): string {
  return scope === 'all' ? 'ALL job emails' : 'this type of job email'
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const verified = verifyActionToken(token, 'unsub')
  if (!verified.ok) {
    return page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>
      <p style="color:#475569;font-size:14px;">You can manage all email preferences from your account settings.</p>`)
  }
  const scope = verified.payload.action
  if (!STREAMS.has(scope)) return page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>`)
  return page(`<h1 style="font-size:20px;">Stop ${describeScope(scope)}?</h1>
    <p style="color:#475569;font-size:14px;">One click and we stop. You can turn them back on from settings any time.</p>
    <form method="POST" action="/api/email/unsubscribe?token=${encodeURIComponent(token)}">
      <button type="submit" style="background:#0f172a;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;">Unsubscribe</button>
    </form>`)
}

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const verified = verifyActionToken(token, 'unsub')
  if (!verified.ok) return page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>`)
  const scope = verified.payload.action
  if (!STREAMS.has(scope)) return page(`<h1 style="font-size:20px;">This link isn't valid anymore</h1>`)

  await connectDB()
  // 'all' is stored as the explicit marker itself — never a fan-out
  // (EMAILS.md §3, Codex #530).
  await User.updateOne(
    { _id: verified.payload.uid },
    { $addToSet: { 'emailPreferences.jobs.unsubscribedStreams': scope } }
  )
  return page(`<h1 style="font-size:20px;">Done — you won't get ${describeScope(scope)} anymore</h1>
    <p style="color:#475569;font-size:14px;">Changed your mind later? Settings → Notifications.</p>`)
}
