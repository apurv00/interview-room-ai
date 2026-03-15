import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import mongoose from 'mongoose'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('userId')
    const type = searchParams.get('type') // 'digest' | 'reminders'

    if (!userId || !type) {
      return new NextResponse('Missing parameters', { status: 400 })
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return new NextResponse('Invalid user ID', { status: 400 })
    }

    await connectDB()

    const updateField = type === 'digest'
      ? { 'emailPreferences.digest': false }
      : { 'emailPreferences.reminders': false }

    await User.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: updateField },
    )

    // Return a simple HTML confirmation page
    return new NextResponse(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family: -apple-system, sans-serif; background: #0a0f1a; color: #d1d5db; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center; padding: 24px;">
    <h1 style="color: #f0f2f5; font-size: 20px;">Unsubscribed</h1>
    <p style="font-size: 14px; margin-top: 8px;">You've been unsubscribed from ${type === 'digest' ? 'digest emails' : 'practice reminders'}.</p>
    <a href="/" style="color: #3b82f6; font-size: 14px; margin-top: 16px; display: inline-block;">Back to Interview Prep Guru</a>
  </div>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html' },
    })
  } catch {
    return new NextResponse('Something went wrong', { status: 500 })
  }
}
