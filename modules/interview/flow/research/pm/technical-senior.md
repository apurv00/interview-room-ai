# Product Manager — Technical Interview — Senior Level (7+ yr / GPM / Director)

NOTE: Senior PM "technical" tests ability to build and scale analytical infrastructure and experimentation culture — not just run one experiment.

## Topic Sequence (typical order)
1. **Metrics Architecture for a Product Area** — "You took over 5 teams with no shared metrics framework. Design one." Hierarchy across teams, leading vs. lagging, cascading from company OKRs, tension when team metrics conflict.
2. **Experimentation Program Design** — "Org runs 200 experiments/quarter but teams don't trust results. Fix this." Platforms, governance, interaction effects, holdout groups, institutional memory.
3. **Data Strategy and Infrastructure Prioritization** — "Limited data engineering resources. How decide what to instrument, build, defer?" Data infra as product investment, not support function.
4. **Technical Roadmap and Architecture Influence** — "Product's monolith causing reliability issues. Engineering wants 6-month rewrite. Evaluate." THE signature senior PM question. Quantify tech debt impact, incremental vs. big-bang, maintain velocity, frame for exec buy-in.
5. **Causal Inference Beyond A/B** — "Can't A/B test this (regulatory, network effects). How evaluate impact?" Diff-in-diff, regression discontinuity, synthetic controls, interrupted time series. When each appropriate + limitations.
6. **ML/AI Product Decisions** — "Team wants ML-powered recommendations. Questions before greenlighting?" Training data, cold-start, fairness/bias, build vs. buy, success metrics, failure modes.
7. **Platform and API Strategy** — "Build as platform for other teams or keep as product feature?" Platform economics, adoption incentives, maintenance burden, API contracts, premature platformization.
8. **Incident Response at Scale** — "Core metric dropped 20% overnight. Walk through first 2 hours." Triage, distinguishing pipeline issues from product problems, communication protocols, decisions with partial info.
9. **Privacy & Measurement Constraints** — "GDPR/ATT broke core measurement approach. Now what?" Differential privacy, aggregated reporting, cohort-based analysis, regulatory adaptation.
10. **Cross-Functional Data Alignment** — "Marketing, Product, Finance report different DAU numbers. Resolve." Metric governance, canonical definitions, organizational politics around data.

## Phase Structure
- **Phase 1 (0-5 min):** Framing — complex organizational/product scenario
- **Phase 2 (5-20 min):** Strategic analytical problem (metrics architecture or experimentation program)
- **Phase 3 (20-35 min):** Technical judgment under ambiguity (architecture tradeoff, ML decision, causal inference)
- **Phase 4 (35-45 min):** Organizational/scaling question — design the system or culture, not just solve the instance

## What Makes This Level Unique
- Questions shift from **solving problems** to **designing systems that prevent problems.** Answer is a framework, process, or organizational structure.
- Interviewers (VPs/senior directors) evaluate whether they'd trust this person in technical architecture reviews and data strategy discussions.
- **"I don't know but here's how I'd find out" no longer sufficient.** Expected to have experience-formed opinions and defend them while remaining open.
- Canonical question: **two-way door / one-way door assessment** — correctly classify decisions by reversibility and adjust process.
- Google L7+/Meta E7+ often involve mock "architecture review" or "metric review" roleplay.
- Amazon Director PM includes "technical bar raise" testing evaluation of engineering proposals and second-order questions.

## Anti-Patterns
- Same depth as mid-level — solving instance instead of designing system
- Not addressing organizational dynamics (who owns metric, how build consensus)
- All technical investments as "obviously worth it" or "obviously not" — no evaluation framework
- Over-relying on A/B testing as answer to everything (must know when it doesn't work)
- No point of view on build vs. buy for data/ML infrastructure
- Ignoring privacy and regulatory constraints
- Solutions that don't scale — thinking single team when question is about organization

## Probe Patterns
- "Three teams claim credit for metric improvement. How attribute?" (incrementality, holdouts, org-scale causal reasoning)
- "Board wants single 'product health' number. What give, what refuse to collapse?" (exec metric communication)
- "Best engineer disagrees with your direction. 15 years experience. How does conversation go?" (technical credibility without authority)
- "Investment won't show impact for 18 months. How justify?" (leading indicators, proxy metrics)
- "Inherited team that ships without instrumenting. 6 months missing data. What do you do?" (pragmatic recovery)
- "Two PMs designed conflicting experiments that can't run simultaneously. Resolve." (experimentation governance)

## Sources
- Google L7/L8 PM loops (Sachin Rekhi, Ken Norton essays)
- Meta E7 "Technical Leadership" round (Blind 2023-2025)
- Amazon Director PM loop — Leadership Principles + technical depth
- Trustworthy Online Controlled Experiments (Kohavi et al.) — Ch. 22 experimentation maturity
- Reforge "Product Strategy" and "Experimentation & Testing"
- Marty Cagan — Empowered (product leadership technical judgment bar)
