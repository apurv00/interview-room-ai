import { MongoClient } from 'mongodb'

const options = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
}

const globalWithMongo = global as typeof globalThis & {
  _mongoClientPromise?: Promise<MongoClient>
}

function getClientPromise(): Promise<MongoClient> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    // Return a promise that rejects lazily so it doesn't crash at build time
    return Promise.reject(new Error('MONGODB_URI environment variable is not defined'))
  }

  // Cache the client promise in both dev and production to avoid
  // creating a new TCP connection on every serverless invocation.
  if (!globalWithMongo._mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI, options)
    globalWithMongo._mongoClientPromise = client.connect()
  }
  return globalWithMongo._mongoClientPromise
}

const clientPromise = getClientPromise()

export default clientPromise
