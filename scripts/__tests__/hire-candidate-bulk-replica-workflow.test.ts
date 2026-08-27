import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface ReplicaWorkflowContract {
  on?: {
    push?: { branches?: string[] }
    workflow_dispatch?: {
      inputs?: { release_sha?: { required?: boolean; type?: string } }
    }
  }
}

const WORKFLOW_PATH = resolve(
  process.cwd(),
  '.github/workflows/hire-candidate-bulk-replica-test.yml',
)

function workflowSource(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8')
}

describe('candidate bulk replica workflow', () => {
  it('runs for every main push and retains explicit exact-SHA manual reruns', () => {
    const workflow = workflowSource()
    const contract = parse(workflow) as ReplicaWorkflowContract

    expect(contract.on?.push?.branches).toEqual(['main'])
    expect(contract.on?.workflow_dispatch?.inputs?.release_sha).toMatchObject({
      required: true,
      type: 'string',
    })
    expect(workflow).toContain(
      "REQUESTED_RELEASE_SHA: ${{ github.event_name == 'push' && github.sha || github.event.inputs.release_sha }}",
    )
    expect(workflow).toContain('ref: ${{ env.REQUESTED_RELEASE_SHA }}')
  })

  it('binds the exact checkout to main before starting disposable MongoDB', () => {
    const workflow = workflowSource()
    const validateOffset = workflow.indexOf('name: Validate exact release request')
    const checkoutOffset = workflow.indexOf('uses: actions/checkout@v4')
    const bindOffset = workflow.indexOf(
      'name: Bind gate evidence to the exact release commit',
    )
    const mongoOffset = workflow.indexOf(
      'name: Start disposable MongoDB replica set',
    )

    expect(validateOffset).toBeGreaterThan(-1)
    expect(checkoutOffset).toBeGreaterThan(validateOffset)
    expect(bindOffset).toBeGreaterThan(checkoutOffset)
    expect(mongoOffset).toBeGreaterThan(bindOffset)

    const validation = workflow.slice(validateOffset, checkoutOffset)
    expect(validation).toContain('^[0-9a-f]{40}$')
    expect(validation).toContain('GITHUB_REF')
    expect(validation).toContain('!= "refs/heads/main"')

    const binding = workflow.slice(bindOffset, mongoOffset)
    expect(binding).toContain('git rev-parse HEAD')
    expect(binding).toContain('git fetch --no-tags origin main')
    expect(binding).toContain(
      'git merge-base --is-ancestor "$REQUESTED_RELEASE_SHA" origin/main',
    )
  })
})
