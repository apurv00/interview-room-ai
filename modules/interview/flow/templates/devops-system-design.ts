import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── DevOps × System Design × 0-2 ───────────────────────────────────────────
const entry: CompactSlot[] = [
  ['infra-problem-intro', 'Problem introduction and requirements', 'problem-solving', 'warm-up', 'must', 0,
    'Present a contained infra problem (e.g. a zero-downtime deploy pipeline). Assess whether they clarify before designing.',
    'Surface — note what they ask about constraints.', 'Hints and guidance through the constraints are expected.'],
  ['high-level-arch', 'High-level architecture', 'operational', 'exploration', 'must', 2,
    'Ask for the major components and how a change flows to production. Look for a sensible, simple design.',
    'Probe where a build runs, how it deploys, and where it could break.'],
  ['rollback-strategy', 'Deployment and rollback approach', 'operational', 'exploration', 'must', 2,
    'Ask how they avoid downtime and recover from a bad deploy. Look for health checks and a rollback path.',
    'Probe what "zero downtime" actually requires (draining, readiness, DB changes).'],
  ['monitoring-the-design', 'Monitoring and alerting for the system', 'operational', 'exploration', 'must', 2,
    'Ask what they\'d monitor and alert on for this system. Look for user-facing signals, not just CPU.',
    'Probe alert thresholds and how they\'d know a deploy made things worse.'],
  ['basic-failure-modes', 'Basic failure handling', 'operational', 'exploration', 'if-time', 2,
    'Ask what fails and what happens when it does. Look for awareness even without a complete solution.',
    'Probe a single point of failure and a simple mitigation.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['design-reflection', 'What you\'d improve with more time', 'problem-solving', 'closing', 'must', 0,
    'Ask what they\'d harden or add given more time. Assess self-awareness about gaps.',
    'Surface — wrap up.'],
]

// ─── DevOps × System Design × 3-6 ───────────────────────────────────────────
const mid: CompactSlot[] = [
  ['problem-constraints', 'Problem, requirements, and constraints', 'problem-solving', 'warm-up', 'must', 0,
    'Present a real problem (DR strategy or cloud migration) with budget/compliance constraints. Expect proactive scoping.',
    'Surface — less hand-holding; engineering judgment is the signal.', 'Constraints (RTO/RPO, cost, compliance) are part of the problem.'],
  ['constrained-architecture', 'Architecture under cost and compliance constraints', 'operational', 'exploration', 'must', 2,
    'Ask for the architecture given the constraints. Look for tradeoffs against budget and regulatory needs.',
    'Probe RTO/RPO targets and how the design meets them.',
    'Should weigh cost vs reliability explicitly.'],
  ['automation-strategy', 'Automation and IaC strategy', 'automation', 'exploration', 'must', 2,
    'Ask how the system is provisioned and operated repeatably. Look for IaC and pipeline thinking.',
    'Probe how they prevent drift and roll changes safely.'],
  ['incident-readiness', 'Monitoring and incident readiness', 'operational', 'exploration', 'must', 2,
    'Ask how the team would detect and respond to failure here. Look for runbooks and on-call readiness.',
    'Probe what gets paged and how they\'d test the response.'],
  ['phased-migration', 'Phasing and rollback for the migration', 'operational', 'exploration', 'if-time', 2,
    'Ask how they\'d phase the change to limit blast radius. Look for incremental cutover, not big-bang.',
    'Probe the rollback plan at each phase.'],
  ['capacity-scaling', 'Capacity and scaling', 'operational', 'exploration', 'if-time', 2,
    'Ask how the system scales with load and how they\'d size it. Look for real numbers and headroom.',
    'Probe the bottleneck and how it\'s relieved.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['biggest-risk', 'The biggest risk in your design', 'problem-solving', 'closing', 'must', 0,
    'Ask what worries them most about the design. Assess risk awareness.',
    'Surface — wrap up.'],
]

// ─── DevOps × System Design × 7+ ────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['ambiguous-scoping', 'Ambiguous problem — candidate drives scope', 'problem-solving', 'warm-up', 'must', 0,
    'Present a deliberately broad problem (global SaaS infra, incident-response system). Candidate must drive scope.',
    'Surface — note the quality of clarifying questions.', 'Candidate must lead the conversation, not wait for prompts.'],
  ['global-architecture', 'Multi-region / global architecture', 'technical-breadth', 'exploration', 'must', 2,
    'Ask for a multi-region design balancing latency, cost, and resilience. Look for active-active vs active-passive reasoning.',
    'Probe traffic routing, region failover, and the cost of the choice.'],
  ['data-consistency-failover', 'Data consistency and failover', 'operational', 'exploration', 'must', 2,
    'Ask how data stays consistent across regions and what happens on a region loss. Look for honest CAP tradeoffs.',
    'Probe replication lag, split-brain, and recovery.',
    'Must confront the hard consistency-vs-availability tradeoff, not hand-wave it.'],
  ['finops-modeling', 'Cost modeling and FinOps', 'operational', 'exploration', 'must', 2,
    'Ask how they\'d model and govern the cost of this infrastructure. Look for accountability, not just savings.',
    'Probe where the money goes and how teams are held accountable.'],
  ['operational-readiness', 'Operational readiness and org design', 'leadership', 'exploration', 'if-time', 2,
    'Ask how teams run this in production — ownership, runbooks, on-call, change management.',
    'Probe how they\'d roll this out across an org and keep it reliable.'],
  ['compliance-security', 'Compliance and security at scale', 'operational', 'exploration', 'if-time', 2,
    'Ask how compliance and security are built in (not bolted on). Look for automation of controls.',
    'Probe how they prove compliance continuously.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['org-implications', 'Organizational implications of the design', 'leadership', 'closing', 'must', 0,
    'Ask what this design demands of the organization — teams, skills, process. Assess systems-level leadership.',
    'Surface — assess forward-looking org thinking.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('devops', 'system-design', '0-2', entry, [
    'Multi-region active-active or global consistency',
    'FinOps modeling and org-wide cost governance',
    'Org design and change management',
    'Penalizing for needing guidance through constraints',
    'Application data-model design with no infrastructure framing',
  ]),
  template('devops', 'system-design', '3-6', mid, [
    'Single-region "happy path" with no failure handling',
    'Global active-active architecture (senior territory)',
    'Accepting a design with no cost or compliance consideration',
    'Big-bang migrations with no phasing or rollback',
  ]),
  template('devops', 'system-design', '7+', senior, [
    'Hand-holding through requirements',
    'Designs that ignore cost or organizational reality',
    'Single points of failure with no mitigation',
    'Avoiding the consistency-vs-availability tradeoff',
  ]),
]
