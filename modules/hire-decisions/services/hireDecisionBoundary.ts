import { connectHireControlDB } from '@hire-decision-boundary'

/**
 * Decision records reside in the existing isolated Hire control database.
 * This deliberately does not connect to B2C users, interview runtime, or
 * shared application persistence.
 */
export async function connectHireDecisionDB(): Promise<void> {
  await connectHireControlDB()
}
