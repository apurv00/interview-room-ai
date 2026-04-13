# Data Science — Coding Interview — Senior Level (7+ years)

## Problem Types
- **Production ML Coding (30-40%):** Debug broken PyTorch/NumPy training loop (convergence bug, shape mismatch, gradient issue). Implement/extend model architectures (Transformer blocks, attention, LoRA). Build inference pipelines (KV cache, beam search, batched inference). Autograd-style backpropagation for computation graph. Quantization, distillation, pruning in code.
- **ML System Design as Code (25-35%):** Design + pseudocode for end-to-end pipelines. Feature pipeline (batch + streaming). Serving infra (real-time vs batch, latency budgets: 1-5ms feature fetch, 10-30ms model compute, 10-20ms network). A/B test framework design. Drift detection code.
- **Hard DSA + ML Hybrid (15-20%):** Medium-Hard LeetCode with follow-ups. OO design. Google "follow-up escalation" mechanic — can't be memorized.
- **Advanced SQL / Data Architecture (10-15%):** Query optimization, execution plans, indexing strategy. Complex analytical queries with business context.
- **Statistical Methods at Scale (5-10%):** Power analysis, sequential testing, multi-armed bandit implementation. Propensity score matching, diff-in-diff computation.

## Difficulty Level
- Coding: Medium-Hard to Hard (with escalating follow-ups)
- ML Implementation: Hard — debug existing complex code or implement non-trivial architectures
- 6-7 rounds in onsite (more than mid-level), each 45-60 min

## Phase Structure (45-60 min)
1. **Problem Framing (3-5 min):** Reframe problem, identify hidden constraints, challenge assumptions. Define scope proactively.
2. **Architecture/Approach (8-12 min):** System-level approach before coding. ML: architecture, loss function, optimization. System design: pipeline, bottlenecks.
3. **Implementation (20-30 min):** Production-quality: error handling, modular, type hints. Senior engineering practices.
4. **Escalation & Extension (8-12 min):** "Scale to 1B rows", "Add monitoring", "Handle cold-start", "What if drift?" Tests thinking beyond immediate problem.
5. **Business Impact (3-5 min):** Connect technical decisions to business outcomes. Evaluation → business metrics alignment.

## What Makes This Level Unique
- Shift from "can you implement?" to **"can you reason about production systems?"**
- **Debug over build**: given broken model code, find/fix the bug — more common than greenfield
- **GenAI/LLM fluency now expected (2025-2026)**: GenAI-native apps, optimize LLM inference, Agentic workflows
- **Follow-up depth is core mechanic** — Google uses "follow-up escalation" into unmemorable territory
- **Modeling beyond algorithms**: feature engineering, model selection, aligning eval metrics with business
- **Meta uses AI-assisted coding** (Oct 2025+): CoderPad with AI, testing ability to leverage AI tools effectively
- **Latency budgets**: must know production breakdowns (feature: 1-5ms, model: 10-30ms, network: 10-20ms, serial: 5-10ms) and hit sub-50ms SLAs

## Common DS-Specific Problems
- "PyTorch training loop not converging. Debug." (wrong LR schedule, missing grad zero, wrong loss)
- "Implement Transformer attention (scaled dot-product) in NumPy"
- "Design and code feature store: offline vs online compute, drift handling, <10ms serve latency"
- "Implement beam search with configurable beam width"
- "Batch inference pipeline: 10M records, GPU memory constraints — batching, OOM, checkpointing"
- "Implement model distillation: teacher outputs → train student"
- "Design A/B test analysis framework: sample size, sequential analysis, guardrails"
- "Implement KV cache for autoregressive generation, explain memory-compute tradeoff"

## Anti-Patterns
- Treating coding as isolated algorithm exercise instead of demonstrating system thinking
- Not discussing production concerns (monitoring, failure, scalability) with ML code
- Accuracy without latency, cost, interpretability tradeoffs
- Passively waiting for questions — at senior level, must lead
- Not knowing online vs offline serving tradeoffs
- Ignoring data quality, drift, retraining in system design
- Research-quality code (notebooks) instead of production-quality (modular, tested, error-handled)
- At staff: not showing cross-team influence or strategic thinking

## Sources
- Yuan Meng — MLE Interview 2.0: Research Engineering
- InterviewKickStart — Senior DS Interview Process
- HelloInterview — ML System Design in a Hurry
- SystemDesignHandbook — ML System Design Interview Guide
- Exponent — ML System Design Interview Guide
- GitHub — Machine-Learning-Interviews (alirezadir)
