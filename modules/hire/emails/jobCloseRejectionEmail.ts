import { escapeHtml } from '@shared/services/emailTemplates/htmlEscape'

/** The close command accepts only these deterministic, recipient-safe slots. */
export const HIRE_CLOSE_EMAIL_TEMPLATE_PLACEHOLDERS = [
  'candidate_first_name',
  'job_title',
  'workspace_name',
] as const

export type HireCloseEmailTemplatePlaceholder =
  (typeof HIRE_CLOSE_EMAIL_TEMPLATE_PLACEHOLDERS)[number]

export const HIRE_CLOSE_EMAIL_TEMPLATE_SUBJECT_MAX_CHARS = 200
export const HIRE_CLOSE_EMAIL_TEMPLATE_BODY_MAX_CHARS = 4000

export interface JobCloseRejectionEmailTemplate {
  subject: string
  body: string
}

/**
 * Final recipient-specific copy persisted by the close transaction. The
 * outbox worker only renders this immutable copy; it never rereads a mutable
 * recruiter template on a later retry.
 */
export interface JobCloseRejectionEmailSnapshot {
  subject: string
  body: string
}

export interface JobCloseRejectionEmailParams {
  candidateName: string
  jobTitle: string
  workspaceName: string
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function firstName(value: string): string {
  return singleLine(value).split(/\s+/)[0] || 'there'
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

/**
 * Returns a concise validation reason for malformed braces or unsupported
 * tokens. Literal braces are intentionally not accepted: this prevents a
 * malformed token from being silently sent as candidate-facing copy.
 */
export function getHireCloseEmailTemplatePlaceholderError(value: string): string | null {
  let cursor = 0
  while (cursor < value.length) {
    const nextOpen = value.indexOf('{', cursor)
    const nextClose = value.indexOf('}', cursor)
    if (nextOpen === -1 && nextClose === -1) return null
    if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
      return 'Template placeholders must use balanced braces'
    }
    if (nextOpen === -1) return 'Template placeholders must use balanced braces'

    const close = value.indexOf('}', nextOpen + 1)
    if (close === -1) return 'Template placeholders must use balanced braces'
    const token = value.slice(nextOpen + 1, close)
    if (token.includes('{') || token.includes('}')) {
      return 'Template placeholders must use balanced braces'
    }
    if (!(HIRE_CLOSE_EMAIL_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(token)) {
      return `Unsupported placeholder {${token}}`
    }
    cursor = close + 1
  }
  return null
}

/**
 * Service-side defense for trusted callers that bypass the HTTP validator.
 * The API schema gives user-facing Zod errors; this prevents any internal
 * write path from persisting an unsafe or ambiguous template accidentally.
 */
export function assertValidHireCloseEmailTemplate(
  template: JobCloseRejectionEmailTemplate,
): JobCloseRejectionEmailTemplate {
  if (/[\r\n]/.test(template.subject)) {
    throw new Error('Close-email subject must not contain line breaks')
  }
  if (template.subject.length > HIRE_CLOSE_EMAIL_TEMPLATE_SUBJECT_MAX_CHARS) {
    throw new Error('Close-email subject is too long')
  }
  if (template.body.length > HIRE_CLOSE_EMAIL_TEMPLATE_BODY_MAX_CHARS) {
    throw new Error('Close-email body is too long')
  }
  const subjectError = getHireCloseEmailTemplatePlaceholderError(template.subject)
  const bodyError = getHireCloseEmailTemplatePlaceholderError(template.body)
  if (subjectError) throw new Error(subjectError)
  if (bodyError) throw new Error(bodyError)

  const subject = template.subject.trim()
  const body = normalizeBody(template.body)
  if (!subject) throw new Error('Close-email subject is required')
  if (!body) throw new Error('Close-email body is required')
  return { subject, body }
}

function renderTemplate(
  template: JobCloseRejectionEmailTemplate,
  params: JobCloseRejectionEmailParams,
): JobCloseRejectionEmailSnapshot {
  const values: Record<HireCloseEmailTemplatePlaceholder, string> = {
    candidate_first_name: firstName(params.candidateName),
    job_title: singleLine(params.jobTitle),
    workspace_name: singleLine(params.workspaceName),
  }
  const replace = (value: string) => value.replace(
    /\{(candidate_first_name|job_title|workspace_name)\}/g,
    (_match, token: HireCloseEmailTemplatePlaceholder) => values[token],
  )
  return { subject: replace(template.subject), body: replace(template.body) }
}

const DEFAULT_CLOSE_REJECTION_TEMPLATE: JobCloseRejectionEmailTemplate = {
  subject: '{workspace_name}: update on your {job_title} application',
  body: [
    'Hi {candidate_first_name},',
    '',
    'Thank you for the time and care you put into your application for the {job_title} position at {workspace_name}.',
    '',
    'This position has now closed, and we will not be progressing your application further. We appreciate your interest and wish you the best in your search.',
  ].join('\n'),
}

/** Resolve the final per-recipient subject/body before the row is enqueued. */
export function resolveJobCloseRejectionEmailSnapshot(input: {
  candidateName: string
  jobTitle: string
  workspaceName: string
  template?: JobCloseRejectionEmailTemplate
}): JobCloseRejectionEmailSnapshot {
  const template = input.template
    ? assertValidHireCloseEmailTemplate(input.template)
    : DEFAULT_CLOSE_REJECTION_TEMPLATE
  return renderTemplate(template, input)
}

/** Render immutable plain-text copy in a safely escaped HTML email shell. */
export function buildJobCloseRejectionEmailFromSnapshot(
  snapshot: JobCloseRejectionEmailSnapshot,
): { subject: string; html: string; text: string } {
  return {
    subject: snapshot.subject,
    html: `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e; white-space: pre-wrap; line-height: 1.6;">
${escapeHtml(snapshot.body)}
</div>`.trim(),
    text: snapshot.body,
  }
}

/**
 * Candidate-safe close notification. The recruiter's internal close note is
 * intentionally not an input: it is audit evidence, not candidate-facing
 * copy, and may mention the selected candidate or other private context.
 */
export function buildJobCloseRejectionEmail(params: JobCloseRejectionEmailParams): {
  subject: string
  html: string
  text: string
} {
  const candidateFirstName = firstName(params.candidateName)
  const subject = `${singleLine(params.workspaceName)}: update on your ${singleLine(params.jobTitle)} application`
  const nameHtml = escapeHtml(candidateFirstName)
  const jobHtml = escapeHtml(params.jobTitle)
  const workspaceHtml = escapeHtml(params.workspaceName)

  const html = `
<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <h2 style="margin: 0 0 16px;">Hi ${nameHtml},</h2>
  <p style="line-height: 1.6;">
    Thank you for the time and care you put into your application for the
    <strong>${jobHtml}</strong> position at <strong>${workspaceHtml}</strong>.
  </p>
  <p style="line-height: 1.6;">
    This position has now closed, and we won&rsquo;t be progressing your
    application further. We appreciate your interest and wish you the best in
    your search.
  </p>
</div>`.trim()

  const text = [
    `Hi ${candidateFirstName},`,
    '',
    `Thank you for the time and care you put into your application for the ${params.jobTitle} position at ${params.workspaceName}.`,
    '',
    'This position has now closed, and we will not be progressing your application further. We appreciate your interest and wish you the best in your search.',
  ].join('\n')

  return { subject, html, text }
}
