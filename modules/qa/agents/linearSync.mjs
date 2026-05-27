/**
 * Sync P0/P1 QA findings to Linear (create or comment on existing).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const qaRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const LINEAR_API = 'https://api.linear.app/graphql'

const PRIORITY = { P0: 1, P1: 2, P2: 3, P3: 4 }

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {object} [variables]
 */
async function linearGraphql(apiKey, query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (!res.ok || body.errors?.length) {
    throw new Error(body.errors?.[0]?.message ?? `Linear API HTTP ${res.status}`)
  }
  return body.data
}

function loadLinearConfig() {
  const path = join(qaRoot, 'config', 'linear.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function buildDescription(finding, reportId) {
  const lines = [
    finding.impact ?? '',
    '',
    '**Evidence**',
    ...(finding.evidence ?? []).map((e) => `- ${e}`),
    '',
    '**Next steps**',
    ...(finding.nextSteps ?? []).map((s) => `- ${s}`),
  ]
  if (finding.activityLinks?.length) {
    lines.push('', '**Activity artifacts**')
    for (const link of finding.activityLinks) lines.push(`- ${link}`)
  }
  lines.push('', `Run: \`${reportId}\``)
  return lines.join('\n')
}

/**
 * @param {object} opts
 * @param {object[]} opts.findings
 * @param {string} opts.reportId
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.createAll]
 */
export async function syncFindingsToLinear(opts) {
  const { findings, reportId, dryRun = false, createAll = false } = opts
  const apiKey = process.env.LINEAR_API_KEY
  const config = loadLinearConfig()

  if (!apiKey) {
    return { ok: false, skipped: true, reason: 'LINEAR_API_KEY not set' }
  }
  if (!config?.teamId) {
    return { ok: false, skipped: true, reason: 'modules/qa/config/linear.json missing teamId' }
  }

  const severities = createAll ? ['P0', 'P1', 'P2'] : (config.createForSeverity ?? ['P0', 'P1'])
  const eligible = findings.filter(
    (f) =>
      severities.includes(f.severity) &&
      f.status !== 'resolved' &&
      f.status !== 'wont-fix' &&
      f.classification !== 'harness-artifact',
  )

  const results = []

  for (const finding of eligible) {
    const title = `[QA-${finding.severity}] ${finding.stage}: ${finding.title}`
    const searchTitle = finding.id

    if (dryRun) {
      results.push({ findingId: finding.id, action: 'dry-run', title })
      continue
    }

    const searchData = await linearGraphql(
      apiKey,
      `query($filter: IssueFilter) {
        issues(filter: $filter, first: 5) {
          nodes { id identifier title url }
        }
      }`,
      {
        filter: {
          title: { contains: searchTitle },
          labels: { some: { name: { eq: 'qa-auto' } } },
        },
      },
    )

    const existing = searchData.issues?.nodes?.find((n) => n.title.includes(finding.id))

    if (existing) {
      await linearGraphql(
        apiKey,
        `mutation($body: String!, $issueId: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        {
          issueId: existing.id,
          body: `New QA run evidence (${reportId}):\n\n${buildDescription(finding, reportId)}`,
        },
      )
      results.push({ findingId: finding.id, action: 'comment', linearId: existing.identifier, url: existing.url })
      continue
    }

    const createData = await linearGraphql(
      apiKey,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      {
        input: {
          teamId: config.teamId,
          title: `[${finding.id}] ${title}`,
          description: buildDescription(finding, reportId),
          priority: PRIORITY[finding.severity] ?? 3,
          projectId: config.projectId || undefined,
          labelIds: config.labelIds?.length ? config.labelIds : undefined,
        },
      },
    )

    const issue = createData.issueCreate?.issue
    results.push({
      findingId: finding.id,
      action: 'created',
      linearId: issue?.identifier,
      url: issue?.url,
    })
  }

  return { ok: true, synced: results.length, results }
}
