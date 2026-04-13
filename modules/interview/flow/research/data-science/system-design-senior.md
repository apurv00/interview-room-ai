# Data Science — System Design Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Problem formulation with product and business depth** (not just ML objectives)
2. **Multi-system architecture** — multiple ML models interacting (retrieval + ranking + re-ranking + diversity)
3. **Feature platform and data infrastructure design**
4. **Training infrastructure at scale** — distributed training, experiment tracking, model registry
5. **Serving at scale** — real-time inference <50ms, model compression, edge deployment
6. **Monitoring, observability, automated remediation**
7. **Organizational considerations** — experimentation velocity, platform vs. product trade-offs

## Phase Structure (60 min, candidate drives)
- **Frame the problem (5 min):** Product intuition. Sharp clarifying questions showing business context understanding. Define success in business terms first, then translate to ML metrics.
- **Propose architecture (15 min):** Multi-component. Comparative analysis ("X or Y; here's why X"). ML vs. non-ML components. Proactively identify hardest sub-problems.
- **Deep dive — candidate-led (20 min):** Identify and dive into most interesting/risky components *without prompting*. Feature engineering with domain expertise, novel architecture, exploration/exploitation, cold start.
- **Scale, reliability, operations (10 min):** Distributed training. Real-time serving (latency budgets, compression, caching). Drift detection, concept drift, feedback loop delays. Automated retraining.
- **Strategic trade-offs (10 min):** Platform vs. product investment. Tech debt vs. iteration speed. Rebuild vs. improve. Cross-team dependencies. Complex experimentation (interleaving, MAB).

## What Makes This Level Unique
- Must demonstrate **industry awareness** — reference how real companies solve similar problems
- **Comparative analysis** of multiple approaches, not just one solution
- Proactively identify **risks, failure modes, edge cases** without being asked
- Design for **long-term sustainability**, not just initial launch. Tech debt, experimentation velocity, platform evolution.
- Staff+ must show **novel architectural solutions**, not just recombine known patterns
- Advanced topics: exploration/exploitation, RL for personalization, semi-supervised for label scarcity, multi-task for efficiency
- **Organizational dimension**: how to enable other teams, balance platform vs. product-specific work

## Common Problems
- "Design large-scale ML platform for recommendations, search, ads across products" (Meta/Google-scale)
- "Design real-time fraud detection: 100K transactions/sec, <100ms latency"
- "Design end-to-end ML for autonomous vehicle perception (multi-modal)"
- "Design content moderation pipeline for social media at scale"
- "Design ride-matching and pricing (Uber) — multiple ML models in real-time"
- "Design conversational AI with retrieval-augmented generation"
- "Design ML infrastructure for company transitioning from rules to ML"

## Anti-Patterns
- Mid-level answer: single model pipeline without multi-model interactions, platform concerns, org impact
- Not proactively identifying failure modes (stale feature store, silent degradation, feedback loops)
- Ignoring organizational dimension (who builds, maintains, hires)
- Day 1 only without system evolution (Day 30, Day 365)
- Unable to articulate trade-offs between competing approaches
- Purely theoretical without real-world constraints (cost, team size, existing infra)
- Searching for "right answer" — multiple valid designs; quality is in reasoning

## Probe Patterns
- "Proposed X. Principal engineer argues Y. How evaluate?"
- "ROI of building platform vs. buying off-shelf?"
- "Running 6 months, metrics slowly degrading. Walk through diagnosis."
- "How onboard new team? Self-serve vs. white-glove?"
- "Most likely thing to go wrong in production?"
- "Tension between experimentation velocity and model quality?"
- "Cut scope to 3 months instead of 6 — what drop and why?"

## Sources
- Hello Interview — System Design Expectations at Each Level
- System Design Handbook — Meta/Google ML System Design
- InterviewQuery — Meta ML Engineer Interview 2025
- GitHub — alirezadir ML System Design
- Chip Huyen — ML Systems Design Exercises
