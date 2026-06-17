import { template, DEEP_DIVE_1, DEEP_DIVE_2, type CompactSlot } from '../slotBuilder'
import type { FlowTemplate } from '../types'

// ─── DevOps × Coding × 0-2 ──────────────────────────────────────────────────
const entry: CompactSlot[] = [
  ['coding-warmup', 'Problem introduction and clarification', 'problem-solving', 'warm-up', 'must', 0,
    'Present an easy automation problem (parse log lines, parse a key=value config). Assess whether they clarify input format.',
    'Surface — note clarifying questions about malformed input.', 'Hints are expected and acceptable.'],
  ['approach-discussion', 'Approach — parse then aggregate', 'problem-solving', 'exploration', 'must', 2,
    'Ask them to outline the approach before coding. Look for a clean parse → transform → output flow.',
    'Probe how they handle malformed or unexpected lines.', 'Working straightforward solution is sufficient.'],
  ['coding-impl', 'Implementation', 'technical-depth', 'exploration', 'must', 2,
    'Candidate implements the parser/aggregator. Provide hints if stuck. Assess correct, readable code.',
    'Probe variable naming and basic structure.'],
  ['edge-cases-trace', 'Edge cases and trace-through', 'problem-solving', 'exploration', 'must', 1,
    'Ask them to trace one or two inputs, including a malformed line. Assess ability to catch bugs.',
    'Probe empty input, missing fields, and duplicate keys.'],
  ['practical-followup', 'Practical follow-up', 'technical-depth', 'exploration', 'if-time', 2,
    'If time, extend it: count per level, or override earlier config keys. Assess incremental change handling.',
    'Probe how their structure adapts to the new requirement.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['coding-closing', 'Approach reflection', 'problem-solving', 'closing', 'must', 0,
    'Ask what they\'d do differently with more time. Assess self-awareness.',
    'Surface — wrap up.'],
]

// ─── DevOps × Coding × 3-6 ──────────────────────────────────────────────────
const mid: CompactSlot[] = [
  ['problem-scoping', 'Problem scoping and clarification', 'problem-solving', 'warm-up', 'must', 0,
    'Present a medium automation problem (exponential backoff with jitter, sliding-window event aggregation). Expect proactive edge-case ID.',
    'Surface — less hand-holding; engineering judgment is key.', 'Failure handling is part of the problem, not an afterthought.'],
  ['approach-tradeoffs', 'Approach with tradeoffs', 'problem-solving', 'exploration', 'must', 2,
    'Expect them to reason about the algorithm and its complexity. Assess tradeoff thinking.',
    'Probe why this approach and what the time/space cost is.'],
  ['clean-implementation', 'Clean implementation', 'technical-depth', 'exploration', 'must', 2,
    'Assess code quality: readability, modularity, and explicit handling of timeouts/retries/partial failure.',
    'Probe design decisions in the structure.', 'Failure handling matters as much as the happy path here.'],
  ['self-testing', 'Self-driven testing', 'problem-solving', 'exploration', 'must', 2,
    'Expect them to test corner cases unprompted: zero attempts, max-delay cap, late/out-of-order events.',
    'Probe testing strategy and self-correction.'],
  ['ops-oriented', 'Ops-oriented extension', 'technical-depth', 'exploration', 'if-time', 2,
    'Extend toward real ops logic: bound memory for the window, or add jitter strategy. Assess production-mindedness.',
    'Probe memory bounds, thundering-herd avoidance, and observability hooks.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['production-followup', 'Production readiness follow-up', 'technical-depth', 'closing', 'must', 0,
    'Ask how this behaves under load and how they\'d monitor it. Assess real-world awareness.',
    'Surface — wrap up.'],
]

// ─── DevOps × Coding × 7+ ───────────────────────────────────────────────────
const senior: CompactSlot[] = [
  ['requirements-from-vague', 'Requirements from a vague prompt', 'problem-solving', 'warm-up', 'must', 0,
    'Present a vague automation problem (a rate limiter, a job scheduler, host bin-packing). Candidate drives scope.',
    'Surface — note the quality of questions asked.', 'Candidate must drive the conversation.'],
  ['design-in-code', 'Design and approach before implementing', 'technical-depth', 'exploration', 'must', 2,
    'Expect interface/structure design before coding, with 2-3 approaches and tradeoffs.',
    'Probe scalability, failure modes, and maintainability of each approach.',
    'Architect before implementing.'],
  ['production-quality-impl', 'Production-quality implementation', 'technical-depth', 'exploration', 'must', 2,
    'Assess error handling, clock-skew/timeout handling, clean abstractions, and separation of concerns.',
    'Probe "why this abstraction?" and how it extends to the distributed case.', 'Trade-off articulation is mandatory.'],
  ['comprehensive-testing', 'Comprehensive testing strategy', 'problem-solving', 'exploration', 'must', 2,
    'Expect non-obvious edge cases: burst traffic, clock skew, concurrent access, partial failure.',
    'Probe load and chaos testing thinking.'],
  ['distributed-extension', 'Distributed-systems extension', 'technical-depth', 'exploration', 'if-time', 2,
    'Extend to the distributed case: a rate limiter across many nodes, a scheduler with at-least-once semantics.',
    'Probe coordination, consistency, and back-pressure.'],
  DEEP_DIVE_1,
  DEEP_DIVE_2,
  ['extension-monitoring', 'Extension and production monitoring', 'operational', 'closing', 'must', 0,
    'Ask how to scale this, handle requirement changes, and monitor it in production.',
    'Surface — assess forward-looking production thinking.'],
]

export const TEMPLATES: FlowTemplate[] = [
  template('devops', 'coding', '0-2', entry, [
    'Distributed rate limiters or schedulers',
    'System-design-scale problems',
    'Advanced concurrency or consensus',
    'LeetCode-hard algorithmic puzzles',
    'Real infrastructure provisioning (Terraform/Kubernetes) in the editor',
  ]),
  template('devops', 'coding', '3-6', mid, [
    'Trivial parsing problems with hand-holding',
    'Ignoring failure modes (timeouts, retries, partial failure)',
    'Skipping testing discussion',
    'Pure algorithmic puzzles with no operational context',
  ]),
  template('devops', 'coding', '7+', senior, [
    'LeetCode-style puzzles as the primary evaluation',
    'Simple scripts with no design or failure thinking',
    'Ignoring distributed/production concerns',
    'Single-correct-answer problems with no tradeoffs',
  ]),
]
