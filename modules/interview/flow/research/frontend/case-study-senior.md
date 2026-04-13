# Frontend Engineer — Case Study Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Design system migration strategy** (legacy Bootstrap/jQuery to modern library; phased rollout; backward compatibility)
2. **Micro-frontend architecture decision** (when to adopt; module federation vs. single-SPA; team autonomy vs. consistency)
3. **Performance crisis triage** (Core Web Vitals regression; bundle size explosion; rendering bottleneck identification)
4. **Cross-team platform decisions** (shared component library governance; versioning strategy; design token architecture)
5. **Legacy monolith modernization** (strangler fig for frontend; incremental React adoption; routing coexistence)
6. **Build vs. buy technical evaluation** (evaluate 3rd-party libraries; assess risk; make data-backed recommendation)
7. **Feature flag and rollout strategy** (canary deployments; A/B testing infrastructure; gradual rollout to millions)
8. **Organizational scaling scenario** (10 teams sharing one frontend; code ownership; contribution models; breaking changes)

## Phase Structure
Format: **Scenario discussion** (45-60 min), sometimes with whiteboard; rarely pure coding
- **Problem framing (10 min):** Clarify business context, constraints, stakeholders, timeline
- **Exploration & options (10-15 min):** Present 2-3 architectural approaches with trade-offs
- **Deep dive on chosen approach (15-20 min):** Detailed migration plan, phased rollout, risk mitigation
- **Organizational & process (10 min):** Team structure, governance, documentation, adoption metrics
- **Edge cases & failure modes (5-10 min):** What could go wrong, rollback strategy, monitoring

## What Makes This Level Unique
- This is a **strategic architecture discussion**, not coding
- Evaluates **organizational thinking**: how architecture decisions affect team velocity, ownership, DX
- Must demonstrate **multi-year technical strategy** evaluation with clear phases
- Expected to discuss **governance models**: who owns design system, contribution process, breaking change policy
- Should show awareness of **industry precedent** (Airbnb, Spotify, Netflix approaches)
- Must balance **technical idealism vs. pragmatic delivery**
- **Communication skills** heavily weighted: explain complex trade-offs to non-technical stakeholders

## Common Problems/Scenarios
- "15 frontend teams, different component libraries. Design unified design system strategy."
- "jQuery monolith with 2M LOC. Propose migration plan to React."
- "Core Web Vitals dropped 40% after feature launch. Investigation and remediation."
- "Should we adopt micro-frontends? Three teams request independent deployments."
- "Design versioning and governance for component library used by 20+ teams."
- "Bundle size 4MB. Strategy to get under 500KB."
- "Evaluate: build custom rich text editor or adopt open-source."
- "Design feature flag system for gradual frontend rollouts to 50M users."

## Anti-Patterns (do NOT expect at this level)
- Jumping to solution without framing the problem
- All-or-nothing thinking (full rewrite instead of incremental migration)
- Ignoring organizational impact
- Being dogmatic about one technology
- No rollback plan
- Underestimating migration effort (testing, docs, training)
- Treating it as a coding problem when interviewer wants strategic reasoning

## Probe Patterns
- "How get buy-in from teams who don't want to migrate?"
- "Metrics to measure migration success?"
- "Rollback plan if new architecture performs worse?"
- "How handle transition where old and new coexist?"
- "How staff and organize the team?"
- "What cut if only 6 months instead of 18?"
- "How prevent design system from becoming bottleneck?"
- "How communicate this to VP of Engineering?"

## Sources
- Medium — 20 Senior Frontend Architect Interview Questions
- Dwarves Foundation — Micro-Frontend Case Study
- Frontend Mastery — System Design Interview Guide
- Brad Frost — Design System Versioning
- UXPin — Scalable Component Libraries
