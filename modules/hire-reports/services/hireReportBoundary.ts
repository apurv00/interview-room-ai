import { connectHireControlDB } from '@hire-decision-boundary'

/** Reports use only the isolated Hire-control database. */
export async function connectHireReportDB(): Promise<void> {
  await connectHireControlDB()
}
