import { redirect } from 'next/navigation'

/**
 * Legacy /learn hub page — the flat 6-tile grid diluted pathway's primacy
 * by treating it as one of many. With pathway elevated to the central
 * habit loop, the hub is redundant. Specialty routes (/learn/guides,
 * /learn/practice, /practice/drill, /dashboard) remain directly
 * reachable.
 */
export default function LearnHubRedirect() {
  redirect('/learn/pathway')
}
