# Backend Engineer — Case Study Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Strategic problem framing and stakeholder alignment**
2. **Architectural assessment of existing systems** (technical debt, risk analysis)
3. **Migration strategy design** (strangler fig, parallel runs, feature-flag cutover)
4. **Cross-team coordination and technical proposal** (RFC/ADR process)
5. **Capacity planning and cost modeling**
6. **Organizational change management** (resistance, buy-in, training)
7. **Mentoring and team scaling approach**
8. **Long-term system evolution and maintainability**
9. **Risk mitigation and rollback/failsafe planning**
10. **Post-mortem and incident response process design**

## Phase Structure
Interview is **candidate-led** — resembles a strategic consulting engagement:
- **Ambiguous Problem Presentation (3-5 min):** Broad, intentionally vague scenario at organizational level (e.g., "Our monolith is slowing down feature delivery across 8 teams"). Minimal constraints.
- **Problem Framing & Scoping (10-15 min):** Candidate drives — asks about business goals, team structure, current architecture, timeline, budget. Must frame the problem before solving it.
- **Strategic Solution Design (15-20 min):** Technical strategy covering: assessment approach (portfolio analysis), phased migration plan, team structure changes, success metrics, communication plan.
- **Challenge & Pivot (10-15 min):** Interviewer changes constraints ("CEO wants this in 6 months, not 18" or "Two senior engineers just quit") to test adaptability.
- **Leadership & Influence (5-10 min):** How to get buy-in, handle resistance, mentor team through transition.

## What Makes This Level Unique
- Problems are **organizational and strategic**, not just technical. Scope moves from "design a service" to "transform a platform."
- Must demonstrate **leadership without authority** — influencing across teams.
- Expected to present **technical architecture or strategy they've defined and led** from their own experience.
- Must balance **scalability, performance, cost, and complexity** with structured arguments.
- Assessed on **communicating complexity to non-technical leaders**.
- Must demonstrate **portfolio-level thinking**: which systems to replace, maintain, evolve, or re-engineer.
- Tests whether candidate thinks **beyond forecasted requirements**.

## Common Problems/Scenarios Given
- **Monolith-to-microservices migration strategy:** Aging monolith serving 8 teams, multi-phase plan using strangler fig, API gateway routing, incremental extraction.
- **Evaluate competing technical proposals:** Two architects propose different approaches. Evaluate both considering team capabilities, timelines, business priorities.
- **Legacy system modernization assessment:** Portfolio analysis using business value vs. technical quality matrix. Recommend replace/maintain/evolve for each.
- **Capacity planning and cost optimization:** Infrastructure costs growing 40% YoY. Strategy to reduce while maintaining reliability.
- **Cross-team platform design:** Shared platform (auth, notifications, data pipeline) used by multiple teams, including governance, SLAs, migration path.
- **Incident response process redesign:** On-call burning out team. Design new incident response process, runbook culture, escalation framework.

## Anti-Patterns (do NOT expect at this level)
- Writing production code or implementing a feature
- Junior-style "design a CRUD API" problems
- Reciting specific tool configurations (Terraform syntax, K8s YAML)
- Solving the problem alone without discussing team dynamics
- Well-constrained, narrow problems — the ambiguity IS the test
- Skipping stakeholder analysis and jumping to implementation

## Probe Patterns
- "How would you handle it if team leads resist this approach?" (organizational influence)
- "Business wants Feature X next quarter, but it requires migration first. How do you sequence?" (prioritization)
- "Two senior engineers disagree on target architecture. How do you resolve?" (conflict + decision-making)
- "How do you know this migration is succeeding? What metrics?" (outcome-orientation)
- "What's your rollback plan if new architecture performs worse?" (risk management)
- "How do you ensure knowledge transfer so this isn't bus-factor-one?" (sustainability)

## Sources
- Daily.dev — Hiring Principal Engineers: The Complete Guide
- MockInterviewPro — Top 30 Software Architect Interview Questions
- InterviewPrep — Senior Backend Developer Interview Questions
- BrightHire — 46 Interview Questions for Senior Software Engineer
- InterviewKickstart — Study Plan for Senior Software Engineer Interviews
