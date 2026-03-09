import { MongoClient } from 'mongodb'

const options = {}

const globalWithMongo = global as typeof globalThis & {
  _mongoClientPromise?: Promise<MongoClient>
}

function getClientPromise(): Promise<MongoClient> {
  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    // Return a promise that rejects lazily so it doesn't crash at build time
    return Promise.reject(new Error('MONGODB_URI environment variable is not defined'))
  }

  if (process.env.NODE_ENV === 'development') {
    if (!globalWithMongo._mongoClientPromise) {
      const client = new MongoClient(MONGODB_URI, options)
      globalWithMongo._mongoClientPromise = client.connect()
    }
    return globalWithMongo._mongoClientPromise
  }

  const client = new MongoClient(MONGODB_URI, options)
  return client.connect()
}

const clientPromise = getClientPromise()

export default clientPromise
