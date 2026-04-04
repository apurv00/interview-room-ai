import mongoose from 'mongoose'

interface CachedConnection {
  conn: typeof mongoose | null
  promise: Promise<typeof mongoose> | null
  migrated?: boolean
}

const globalWithMongoose = global as typeof globalThis & {
  mongoose: CachedConnection
}

if (!globalWithMongoose.mongoose) {
  globalWithMongoose.mongoose = { conn: null, promise: null }
}

const cached = globalWithMongoose.mongoose

async function runMigrations(): Promise<void> {
  if (cached.migrated) return
  cached.migrated = true

  try {
    const db = mongoose.connection.db
    if (!db) return
    // Ensure all users have unlimited interviews — handles:
    // - Old users with limit <= 3 (original free plan)
    // - Users whose documents predate the field (field missing)
    // - Any user with a limit below the uncapped default
    await db.collection('users').updateMany(
      {
        $or: [
          { monthlyInterviewLimit: { $exists: false } },
          { monthlyInterviewLimit: null },
          { monthlyInterviewLimit: { $lt: 999999 } },
        ],
      },
      { $set: { monthlyInterviewLimit: 999999 } }
    )
    // Also ensure monthlyInterviewsUsed exists
    await db.collection('users').updateMany(
      { monthlyInterviewsUsed: { $exists: false } },
      { $set: { monthlyInterviewsUsed: 0 } }
    )
  } catch {
    // Non-fatal: migration failure shouldn't block the app
  }
}

export async function connectDB(): Promise<typeof mongoose> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not defined')
  }

  if (cached.conn) return cached.conn

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    })
  }

  try {
    cached.conn = await cached.promise
  } catch (e) {
    cached.promise = null
    throw e
  }

  await runMigrations()

  return cached.conn
}
