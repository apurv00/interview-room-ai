import { redirect } from 'next/navigation'

/**
 * Legacy /learn/progress route — merged into /learn/pathway as part of the
 * habit-loop elevation. The pathway page now owns readiness score,
 * competency trends, and the "what to do next" prompt. Kept as a redirect
 * so bookmarks and existing inbound links stay functional.
 */
export default function ProgressRedirect() {
  redirect('/learn/pathway')
}
