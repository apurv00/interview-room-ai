# Data Science — Case Study Interview — Senior Level (7+ years)

## Topic Sequence (typical order)
1. **Data strategy for a business unit** — How should we use ML to drive growth/efficiency?
2. **ML platform evaluation** — Build vs. buy, vendor assessment, technical roadmap
3. **Experimentation culture design** — Establish org-wide experimentation program
4. **Complex multi-stakeholder scenarios** — Conflicting metrics, org-level trade-offs, team investment
5. **Model governance and lifecycle management at scale**

## Phase Structure (45-60 min, often multi-round)
- **Frame the strategic problem (10 min):** Restate business challenge as data opportunity. Map stakeholders. Define success at org level.
- **Propose a strategy (15 min):** Phased approach (crawl-walk-run). Justify build vs. buy. Estimate ROI and resources. Cold start, feedback loops, scaling.
- **Deep dive on execution (15 min):** Interviewer picks thread: data drift across regions, model priority, engineering buy-in for serving infra.
- **Organizational impact (10 min):** Staffing, measuring team impact, communicating to executives who don't understand ML, governance, compliance.

## What Makes This Level Unique
- Less "solve this problem" → more **"design the data function"**
- Must discuss **scaling, feedback loops, cold start, governance, org change management**
- Articulate impact in **executive terms**: revenue, efficiency, risk reduction
- Look for **influencing without authority** — convincing non-technical stakeholders
- System design merges with strategic planning at this level
- **Build-vs-buy** is common: when off-the-shelf (AutoML, vendor APIs) vs. custom models

## Common Problems
- "No centralized DS function. You're Head of DS. 90-day plan?"
- "Internal ML platform vs. AWS SageMaker / Vertex AI. Walk through evaluation."
- "Data strategy for market expansion into [region]. Data, models, infrastructure?"
- "Three product teams want DS. Budget for two. Prioritize and structure."
- "Recommendation system 3 years old, performance degrading. Rebuild or improve?"
- "Establish experimentation culture for product line that's never done A/B testing?"

## Anti-Patterns
- Staying in model architecture weeds when question is about strategy
- Not discussing org/people dimensions (hiring, team structure, stakeholder management)
- Technically elegant without ROI or feasibility
- Ignoring compliance, privacy, governance (finance, healthcare, HR)
- Generic "build feature store, deploy, monitor" without tailoring to business context
- No "why not" for alternatives

## Probe Patterns
- "Measure ROI of the DS team itself?"
- "VP Engineering says can't support model serving. What do you do?"
- "Model accurate but produces biased outcomes?"
- "Two ML projects: high impact/high risk vs. moderate/low risk. How decide?"
- "Walk through killing a project that wasn't working."
- "Model governance without bureaucracy slowing the team?"

## Sources
- InterviewKickstart — Senior DS Interview Process Guide
- InterviewQuery — Meta ML Engineer Interview 2025
- Exponent — Data Science Interview Prep 2026
- ResumeWorded — Senior DS Interview Questions
