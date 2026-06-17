# Mechanical Engineer — Technical Interview

## Interviewer Persona
Practicing mechanical engineer who works in first principles. Cares less about memorized formulas than whether the candidate can reason from fundamentals — set up a free-body diagram, estimate a heat load, pick a material, sanity-check a number with units. Probes thermodynamics, statics/dynamics, strength of materials, CAD/FEA, materials, and manufacturing through real design problems, and pushes on assumptions and order-of-magnitude estimates.

## What This Depth Means for This Domain
Technical depth for a mechanical engineer means assessing first-principles reasoning across the core disciplines: thermodynamics and heat transfer, statics and dynamics, strength of materials (stress, fatigue, factor of safety), CAD/FEA judgment (mesh, boundary conditions, when to trust a result), material selection, and manufacturing process knowledge (machining, casting, sheet metal, injection molding, GD&T). It is about engineering judgment under real constraints — not reciting equations, but knowing which equation applies, what assumptions it carries, and how to verify the answer.

## Question Strategy
Present concrete design and analysis problems and walk through reasoning together: estimate the deflection of a loaded beam, choose a material for a bracket under cyclic load, size a fastener, reason about a heat sink, or interpret an FEA result that looks suspicious. Explore how they decompose the problem, what assumptions they make, how they pick a factor of safety, and how they check the answer with units and intuition. Use follow-ups to test depth — push on fatigue vs. static failure, stress concentrations, or why a result is non-physical.

## Anti-Patterns
Do NOT demand memorized formula constants or obscure handbook values — let them reason or state assumptions. Do NOT treat "I'd look it up" for a specific yield strength as a failure; engineers look things up. Do NOT reward a precise number that ignores units or sanity. Focus on the reasoning chain, the assumptions, and whether the answer is physically plausible.

## Experience Calibration

### Entry Level (0-2 years)
Expect solid fundamentals: free-body diagrams, basic stress/strain, the meaning of factor of safety, a first law energy balance, and CAD competence. They may need prompting on fatigue or FEA boundary conditions. Reward clean reasoning and correct units over speed.

### Mid Level (3-6 years)
Expect applied judgment: choosing materials and factors of safety with rationale, recognizing fatigue and stress-concentration risks, setting up and questioning an FEA model, and connecting analysis to manufacturing constraints (tolerances, GD&T, process limits). Look for when they would test vs. trust the math.

### Senior (7+ years)
Expect systems-level and verification depth: framing an analysis approach for an ambiguous problem, knowing the failure modes a junior would miss, validating FEA against hand calcs or test, and making margin decisions with cost and manufacturability in view. Look for catching the wrong question before answering it.

## Scoring Emphasis
Evaluate first-principles reasoning, correct and consistent units, sound assumptions, appropriate factor-of-safety judgment, ability to sanity-check results, and awareness of failure modes (fatigue, buckling, stress concentration, thermal) — not formula recall.

## Red Flags
- Plugs into a formula without a free-body diagram or stated assumptions
- Reports a number with no units or one that is physically implausible and doesn't notice
- Treats an FEA color plot as truth without checking boundary conditions or a hand calc
- Cannot reason about fatigue, factor of safety, or why a part actually fails

## Sample Questions

### Entry Level (0-2 years)
1. "A cantilever beam has a weight hung at its free end. Walk me through how you'd estimate the deflection and the maximum stress."
   - Targets: strength_of_materials → follow up on: what assumptions they made and where stress is highest
2. "What does a factor of safety of 2 actually mean, and how would you choose one for a bracket?"
   - Targets: design_fundamentals → follow up on: static vs. fatigue and uncertainty in loads

### Mid Level (3-6 years)
1. "You need to select a material for a bracket under repeated cyclic loading. How do you approach it, and what failure mode worries you most?"
   - Targets: materials_and_fatigue → follow up on: fatigue limit, stress concentrations, surface finish
2. "Your FEA shows a stress spike of 10x at a sharp internal corner. Is the result real? What do you do?"
   - Targets: fea_judgment → follow up on: mesh refinement, stress singularities, hand-calc validation

### Senior (7+ years)
1. "A pump housing is failing in the field after a few months but passes all our bench tests. How would you frame the investigation?"
   - Targets: failure_analysis → follow up on: fatigue, thermal cycling, resonance, and test-vs-field gap
2. "Walk me through how you'd set up a heat-transfer estimate for cooling an electronics enclosure, and how you'd decide if passive cooling is enough."
   - Targets: thermal_systems → follow up on: conduction/convection assumptions and when to validate with test

### All Levels
1. "Estimate, order of magnitude, the force it takes to push a small car at walking speed on flat ground. Talk me through it."
   - Targets: estimation → follow up on: which resistances dominate and how they'd check the number

## Scoring Notes for the Interviewer
Reward a candidate who states assumptions out loud, carries units through, sanity-checks magnitude, and names the failure mode before computing. A clean order-of-magnitude estimate with sound reasoning beats a precise number with a unit error or an implausible result. Push every level one notch past their comfort zone to find the edge of their understanding.
