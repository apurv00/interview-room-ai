import { connectDB } from './connection'
import { Category } from './models/Category'
import { InterviewDomain } from './models/InterviewDomain'
import { InterviewDepth } from './models/InterviewDepth'
import { isKnownCategorySlug, CATEGORY_SLUG_FOR_LEGACY } from '../taxonomy/categoryMaps'

// ─── Categories (data-driven taxonomy buckets) ───────────────────────────────
// Single source of truth for the top-level Category→Domain hierarchy. See
// modules/interview/docs/DOMAIN_TAXONOMY.md. `core-engineering` seeds empty
// (its roles land in Phase 4); the setup grid hides 0-domain categories.
const BUILT_IN_CATEGORIES = [
  { slug: 'programming', label: 'Programming', icon: '💻', description: 'Software & web engineering roles', sortOrder: 1 },
  { slug: 'data-ai', label: 'Data & AI', icon: '📊', description: 'Data science, ML, and analytics', sortOrder: 2 },
  { slug: 'core-engineering', label: 'Core Engineering', icon: '⚙️', description: 'Mechanical, civil, electrical & more', sortOrder: 3 },
  { slug: 'business', label: 'Business', icon: '📈', description: 'Strategy, finance, ops, marketing', sortOrder: 4 },
  { slug: 'product', label: 'Product', icon: '🎯', description: 'Product management & analytics', sortOrder: 5 },
  { slug: 'design', label: 'Design', icon: '🎨', description: 'UX, UI, and product design', sortOrder: 6 },
  // General is the search-fallback escape (not shown as a grid card); sorts last.
  { slug: 'general', label: 'General / Other', icon: '🧭', description: 'Any role — versatile practice', sortOrder: 99 },
]

// Re-cut of each existing domain's legacy `category` onto the new categories.
// (legacy `category` field is left untouched so the current UI is unaffected.)
const CATEGORY_SLUG_BY_DOMAIN: Record<string, string> = {
  general: 'general',
  frontend: 'programming',
  backend: 'programming',
  sdet: 'programming',
  'data-science': 'data-ai',
  pm: 'product',
  design: 'design',
  business: 'business',
  // Phase 4 — freshers' roster (§8.3)
  mechanical: 'core-engineering',
  civil: 'core-engineering',
  electrical: 'core-engineering',
  electronics: 'core-engineering',
  fullstack: 'programming',
  devops: 'programming',
  mobile: 'programming',
  'ml-engineer': 'data-ai',
  'data-analyst': 'data-ai',
  strategy: 'business',
  finance: 'business',
  operations: 'business',
  marketing: 'business',
  sales: 'business',
  'product-analyst': 'product',
  'ui-designer': 'design',
  'product-designer': 'design',
}
// Exact categorySlug for a known built-in domain slug; 'general' otherwise.
// Used by the seed itself (built-in slugs are always known).
export const categorySlugFor = (slug: string): string => CATEGORY_SLUG_BY_DOMAIN[slug] ?? 'general'

/**
 * Resolve a domain's category slug from the best available source, in order:
 *   1. stored `categorySlug` — but only if it is a VALID category. Validity is
 *      checked against `knownSlugs` (the live Category set) when the caller
 *      supplies it, so admin-created custom categories are honored; otherwise it
 *      falls back to the built-in seven. A stale/legacy value (e.g.
 *      'engineering') is rejected so /api/domains never emits a bucket
 *      /api/categories doesn't return.
 *   2. exact built-in slug mapping (precise for seeded domains)
 *   3. legacy `category` label mapping (best-effort for CMS domains)
 *   4. 'general'
 * The legacy<->new maps live in shared/taxonomy/categoryMaps so the seed and the
 * CMS forms share one source of truth.
 */
export const resolveCategorySlug = (
  d: { slug: string; category?: string | null; categorySlug?: string | null },
  knownSlugs?: Set<string>,
): string => {
  const isValid = (s?: string | null): boolean =>
    knownSlugs ? !!s && knownSlugs.has(s) : isKnownCategorySlug(s)
  // Try each candidate in priority order and return the first VALID (active)
  // category. Validating the DERIVED candidates too — not just the stored
  // categorySlug — means /api/domains never emits a bucket /api/categories
  // doesn't return, even when a built-in category was deactivated while its
  // domains stayed active.
  const candidates = [
    d.categorySlug,
    CATEGORY_SLUG_BY_DOMAIN[d.slug],
    d.category ? CATEGORY_SLUG_FOR_LEGACY[d.category] : undefined,
  ]
  for (const c of candidates) {
    if (isValid(c)) return c as string
  }
  // Final fallback: 'general' when it's an active bucket; otherwise the first
  // active category (deterministic — the route fetches categories sorted by
  // sortOrder), so even a domain whose categories were all deactivated still
  // maps to a live bucket /api/categories returns.
  if (isValid('general')) return 'general'
  if (knownSlugs && knownSlugs.size > 0) {
    return Array.from(knownSlugs)[0]
  }
  return 'general'
}

const BUILT_IN_DOMAINS = [
  // ─── General ───────────────────────────────────────────────────────────────
  {
    slug: 'general', label: 'General / Any Role', shortLabel: 'GEN', icon: '🎯', category: 'general' as const, sortOrder: 0,
    description: 'General interview practice — problem-solving, communication, leadership, teamwork, and adaptability.',
    systemPromptContext: 'The candidate wants general interview practice without a specific role focus. Ask versatile questions applicable across roles. Focus on universal competencies: problem-solving, communication, leadership, teamwork, adaptability, and growth mindset.',
    sampleQuestions: ['Tell me about a challenging project you led. What was the outcome?', 'Describe a time you had to learn something new quickly.'],
    evaluationEmphasis: ['communication', 'problem_solving', 'leadership'],
  },
  // ─── Engineering ────────────────────────────────────────────────────────────
  {
    slug: 'frontend', label: 'Frontend Engineer', shortLabel: 'FE', icon: '🖥', category: 'engineering' as const, sortOrder: 1,
    description: 'UI development, React/Angular/Vue, web performance, accessibility, and responsive design.',
    systemPromptContext: 'The candidate is interviewing for a Frontend Engineer role. Probe UI architecture decisions, framework expertise (React, Angular, Vue), web performance optimization, accessibility practices, CSS/design-system fluency, and cross-browser concerns.',
    sampleQuestions: ['Walk me through how you optimized a slow-loading page.', 'How do you approach building accessible components?'],
    evaluationEmphasis: ['technical_depth', 'ui_architecture', 'accessibility'],
  },
  {
    slug: 'backend', label: 'Backend / Infra Engineer', shortLabel: 'BE', icon: '🔧', category: 'engineering' as const, sortOrder: 2,
    description: 'APIs, databases, system design, microservices, scalability, infrastructure, CI/CD, and cloud platforms.',
    systemPromptContext: 'The candidate is interviewing for a Backend/Infrastructure Engineer role. Probe API design, database modeling, system design, microservices architecture, scalability strategies, distributed-systems thinking, infrastructure experience, CI/CD pipeline design, monitoring/observability, incident management, and reliability practices.',
    sampleQuestions: ['Describe a complex system you designed. What tradeoffs did you make?', 'Tell me about a production incident you resolved.', 'Describe your approach to designing a CI/CD pipeline.'],
    evaluationEmphasis: ['technical_depth', 'system_design', 'problem_solving', 'infrastructure_knowledge'],
  },
  {
    slug: 'sdet', label: 'SDET / QA', shortLabel: 'QA', icon: '🧪', category: 'engineering' as const, sortOrder: 3,
    description: 'Test automation, quality strategy, CI/CD testing, performance testing, and reliability.',
    systemPromptContext: 'The candidate is interviewing for an SDET/QA Engineer role. Probe test automation frameworks, quality strategy, CI/CD integration, performance/load testing, and their approach to balancing test coverage with development velocity.',
    sampleQuestions: ['How do you decide what to automate vs. test manually?', 'Describe a test strategy you designed for a complex feature.'],
    evaluationEmphasis: ['test_strategy', 'automation_depth', 'quality_mindset'],
  },
  {
    slug: 'data-science', label: 'Data Science / ML', shortLabel: 'DS', icon: '📊', category: 'engineering' as const, sortOrder: 4,
    description: 'ML models, statistics, experimentation, data storytelling, and business impact.',
    systemPromptContext: 'The candidate is interviewing for a Data Science role. Probe statistical knowledge, ML model building, experiment design (A/B testing), data storytelling, and translating insights to business impact.',
    sampleQuestions: ['Describe an ML model you built that impacted a business metric.', 'How do you design an A/B test?'],
    evaluationEmphasis: ['statistical_knowledge', 'ml_depth', 'business_impact'],
  },
  // ─── Product & Design ──────────────────────────────────────────────────────
  {
    slug: 'pm', label: 'Product Manager', shortLabel: 'PM', icon: '🗂', category: 'product' as const, sortOrder: 5,
    description: 'Product strategy, roadmaps, stakeholder management, and user-centric thinking.',
    systemPromptContext: 'The candidate is interviewing for a Product Manager role. Probe product sense, prioritization frameworks, stakeholder management, metrics-driven thinking, and user empathy.',
    sampleQuestions: ['Tell me about a product you launched from 0 to 1.', 'How do you prioritize features with competing stakeholder demands?'],
    evaluationEmphasis: ['product_sense', 'prioritization', 'metrics_thinking'],
  },
  {
    slug: 'design', label: 'Design / UX', shortLabel: 'UX', icon: '🎨', category: 'product' as const, sortOrder: 6,
    description: 'User research, design thinking, prototyping, and design system expertise.',
    systemPromptContext: 'The candidate is interviewing for a Design/UX role. Probe user research methodology, design thinking process, prototyping skills, accessibility awareness, and collaboration with engineering.',
    sampleQuestions: ['Walk me through your design process for a recent project.', 'How do you handle conflicting feedback from users and stakeholders?'],
    evaluationEmphasis: ['design_thinking', 'user_empathy', 'craft'],
  },
  // ─── Business ──────────────────────────────────────────────────────────────
  {
    slug: 'business', label: 'Business & Strategy', shortLabel: 'BIZ', icon: '🎓', category: 'business' as const, sortOrder: 7,
    description: 'Strategy, consulting, finance, marketing, sales, leadership, and cross-functional impact.',
    systemPromptContext: 'The candidate is interviewing for a Business/Strategy role. Probe strategic thinking, problem structuring, framework application, leadership, analytical skills, client/stakeholder management, executive communication, campaign strategy, financial modeling, risk assessment, deal management, and revenue growth.',
    sampleQuestions: ['Tell me about a time you influenced strategy without direct authority.', 'How would you structure an analysis for a client entering a new market?', 'Describe a campaign or deal you led that exceeded expectations.'],
    evaluationEmphasis: ['strategic_thinking', 'structured_thinking', 'leadership', 'analytical_rigor'],
  },
  // ─── Phase 4 — freshers' roster (§8.3) ─────────────────────────────────────
  {
    slug: 'mechanical', label: "Mechanical Engineer", shortLabel: 'ME', icon: '🔩', category: 'engineering' as const, sortOrder: 10,
    description: "Thermodynamics, mechanics, CAD/FEA, materials, and manufacturing.",
    systemPromptContext: "The candidate is interviewing for a Mechanical Engineer role. Probe thermodynamics, heat transfer, fluid mechanics, statics and dynamics, strength of materials and stress analysis, mechanical design and machine elements, GD&T and tolerancing, CAD modeling (SolidWorks/CATIA/Creo), FEA and CFD simulation, materials selection, manufacturing processes (machining, casting, injection molding, additive), and design-for-manufacturing/assembly tradeoffs.",
    sampleQuestions: ["Walk me through a mechanical part or assembly you designed. How did you choose the material and validate that it would survive the loads?", "How would you approach calculating whether a shaft or bracket will fail under a given load? What factor of safety would you target and why?", "Explain how you would apply GD&T or tolerance stack-up analysis to ensure a part assembles correctly in production.", "Describe a time you used FEA or hand calculations to reduce weight or cost without compromising performance. What tradeoffs did you make?"],
    evaluationEmphasis: ["engineering_fundamentals", "design_tradeoffs", "analytical_rigor", "manufacturing_awareness"],
  },
  {
    slug: 'civil', label: "Civil Engineer", shortLabel: 'CE', icon: '🏗', category: 'engineering' as const, sortOrder: 11,
    description: "Structural analysis, geotechnical, RCC/steel design, and construction.",
    systemPromptContext: "The candidate is interviewing for a Civil Engineer role (Core Engineering). Probe structural analysis (load paths, bending moments, shear, deflection), geotechnical fundamentals (soil bearing capacity, settlement, foundation selection), reinforced concrete and steel design per relevant codes (IS 456 / ACI 318 / AISC), hydraulics and water resources, transportation and pavement design, surveying, construction materials and concrete mix design, and project execution (estimation, BOQ, scheduling, site supervision). Expect fluency with AutoCAD, STAAD.Pro/ETABS, and adherence to applicable design codes and safety/serviceability limit states.",
    sampleQuestions: ["Walk me through how you would analyze a simply supported beam under a uniformly distributed load. How do you determine the maximum bending moment and check it against the section capacity?", "How do you decide between a shallow footing and a pile foundation for a structure? What soil properties drive that decision?", "Describe a project where you used STAAD.Pro or ETABS. What loads did you model and what design checks did you run?", "How would you design a concrete mix for a given target strength, and what factors affect workability and durability on site?"],
    evaluationEmphasis: ["technical_depth", "structural_analysis", "code_compliance", "practical_application"],
  },
  {
    slug: 'electrical', label: "Electrical Engineer", shortLabel: 'EE', icon: '⚡', category: 'engineering' as const, sortOrder: 12,
    description: "Circuits, power systems, control systems, and power electronics.",
    systemPromptContext: "The candidate is interviewing for an Electrical Engineer role. Probe circuit analysis (Ohm's/Kirchhoff's laws, Thevenin/Norton, RLC transients), analog and digital electronics, power systems (three-phase, transformers, load flow, power factor correction), control systems (transfer functions, PID, stability, Bode plots), electrical machines and motor drives, signal and power electronics (rectifiers, inverters, converters), PCB design and schematic capture, electromagnetics, and instrumentation, along with practical lab/measurement experience and relevant safety and standards knowledge.",
    sampleQuestions: ["Walk me through how you would analyze a series RLC circuit's transient response. What determines whether it is underdamped, critically damped, or overdamped?", "Explain the difference between a BJT and a MOSFET. When would you choose one over the other in a design?", "How does a PID controller work, and how would you tune it to stabilize a system that keeps oscillating?", "Describe a circuit or hardware project you built or simulated. What design tradeoffs did you make and how did you test it?"],
    evaluationEmphasis: ["circuit_analysis", "technical_depth", "problem_solving", "practical_application"],
  },
  {
    slug: 'electronics', label: "Electronics & Communication Engineer", shortLabel: 'ECE', icon: '📡', category: 'engineering' as const, sortOrder: 13,
    description: "Analog/digital electronics, signals, communications, and embedded.",
    systemPromptContext: "The candidate is interviewing for an Electronics & Communication Engineer role. Probe analog and digital circuit design, signal processing (sampling, filters, Fourier/Laplace analysis), communication systems (modulation schemes like AM/FM/QAM, channel capacity, antennas), embedded systems and microcontroller programming, digital logic and HDL (Verilog/VHDL), control systems, semiconductor device physics, PCB design, and lab/measurement skills with oscilloscopes and spectrum analyzers.",
    sampleQuestions: ["Walk me through how you would design a low-pass filter for a given cutoff frequency. What components and topology would you choose?", "Explain the difference between AM and FM modulation. When would you prefer one over the other, and how does each affect bandwidth and noise immunity?", "Describe an embedded systems project you built. How did you interface the microcontroller with sensors, and how did you debug timing or communication issues?", "What is the Nyquist sampling theorem, and what happens if you sample below the Nyquist rate? How would you prevent aliasing in a real system?"],
    evaluationEmphasis: ["technical_depth", "signal_processing", "circuit_design", "problem_solving"],
  },
  {
    slug: 'fullstack', label: "Full-stack Engineer", shortLabel: 'FS', icon: '🧩', category: 'engineering' as const, sortOrder: 14,
    description: "End-to-end web — frontend, backend, APIs, and databases.",
    systemPromptContext: "The candidate is interviewing for a Full-stack Engineer role. Probe frontend skills (HTML/CSS, JavaScript/TypeScript, React or similar component frameworks, state management, responsive UI, accessibility), backend skills (REST/GraphQL API design, server-side frameworks like Node/Express, authentication/authorization, database modeling with SQL and NoSQL), and the glue between them (client-server data flow, API integration, caching, performance optimization). Also assess testing, debugging across the stack, version control with Git, and basic deployment/CI awareness.",
    sampleQuestions: ["Walk me through what happens from the moment a user submits a login form to when they see their dashboard — covering both the frontend and backend.", "How would you design the API and data model for a simple to-do app with users, lists, and shared collaborators?", "Describe a time you debugged an issue that spanned both the client and the server. How did you isolate where the problem was?", "How do you manage state in a React app, and when would you reach for a library versus built-in hooks?"],
    evaluationEmphasis: ["full_stack_breadth", "api_design", "frontend_proficiency", "problem_solving"],
  },
  {
    slug: 'devops', label: "DevOps / SRE", shortLabel: 'DevOps', icon: '🔁', category: 'engineering' as const, sortOrder: 15,
    description: "CI/CD, Docker/Kubernetes, IaC, cloud, and reliability.",
    systemPromptContext: "The candidate is interviewing for a DevOps/SRE (Site Reliability Engineer) role. Probe CI/CD pipeline design, containerization and orchestration (Docker, Kubernetes), infrastructure-as-code (Terraform, Ansible, CloudFormation), cloud platforms (AWS/GCP/Azure), Linux systems and networking fundamentals, observability (metrics, logging, tracing, Prometheus/Grafana), incident response and on-call practices, SLIs/SLOs and error budgets, automation and scripting, and capacity, scalability, and reliability engineering. Favor concrete examples of systems they have deployed, monitored, or kept running over textbook definitions.",
    sampleQuestions: ["Walk me through how you would design a CI/CD pipeline to deploy a service to production safely.", "Describe a production incident you helped resolve. How did you detect it, and what did you do to prevent a recurrence?", "How would you set up monitoring and alerting for a new web service? What SLIs and SLOs would you choose?", "Explain how you would containerize an application and deploy it on Kubernetes."],
    evaluationEmphasis: ["technical_depth", "reliability_engineering", "automation_proficiency", "incident_response"],
  },
  {
    slug: 'mobile', label: "Mobile Engineer", shortLabel: 'Mobile', icon: '📱', category: 'engineering' as const, sortOrder: 16,
    description: "iOS/Android & cross-platform apps, lifecycle, and performance.",
    systemPromptContext: "The candidate is interviewing for a Mobile Engineer role. Probe native iOS (Swift/SwiftUI/UIKit) and Android (Kotlin/Jetpack Compose) development, cross-platform frameworks (React Native, Flutter), app lifecycle and state management, UI layout and responsive design, REST/GraphQL API integration, local persistence (Core Data, Room, SQLite), offline-first patterns and caching, push notifications, performance and memory profiling, battery and network efficiency, and app store release and deployment processes.",
    sampleQuestions: ["Walk me through how you'd architect a mobile app that needs to work offline and sync data when the connection returns.", "How do you manage state in a mobile app, and what patterns have you used (e.g., MVVM, Redux, or platform-native approaches)?", "Describe a time you diagnosed and fixed a performance or memory issue on a mobile app. What tools did you use?", "How would you handle API calls and image loading in a scrollable list to keep the UI smooth?"],
    evaluationEmphasis: ["technical_depth", "mobile_architecture", "performance_optimization", "problem_solving"],
  },
  {
    slug: 'ml-engineer', label: "ML Engineer", shortLabel: 'MLE', icon: '🤖', category: 'engineering' as const, sortOrder: 17,
    description: "ML modeling, training pipelines, MLOps, and deployment.",
    systemPromptContext: "The candidate is interviewing for a Machine Learning Engineer role focused on building and shipping ML systems in production. Probe the ML lifecycle end to end: data and feature pipelines, model training and evaluation (loss functions, train/validation/test splits, overfitting, regularization, cross-validation), the bias-variance tradeoff, and choosing the right model and metrics (precision/recall, ROC-AUC) for a problem. Also probe the engineering side — model deployment and serving, MLOps and CI/CD for models, monitoring for data drift and model decay, retraining strategies, latency/throughput tradeoffs, and hands-on experience with frameworks like PyTorch, TensorFlow, or scikit-learn.",
    sampleQuestions: ["Walk me through an ML project you built end to end — how did you go from raw data to a deployed model?", "How would you detect and handle overfitting in a model you trained?", "A model that performed well offline is giving worse predictions in production. How would you debug it?", "Which evaluation metric would you pick for a fraud-detection classifier on an imbalanced dataset, and why?"],
    evaluationEmphasis: ["ml_fundamentals", "model_deployment", "problem_solving", "data_pipeline_skills"],
  },
  {
    slug: 'data-analyst', label: "Data Analyst", shortLabel: 'DA', icon: '📈', category: 'engineering' as const, sortOrder: 18,
    description: "SQL, analytics, experimentation, dashboards, and storytelling.",
    systemPromptContext: "The candidate is interviewing for a Data Analyst role. Probe SQL querying (joins, window functions, aggregations), data cleaning and wrangling, exploratory data analysis, descriptive and inferential statistics, A/B testing and hypothesis testing, building dashboards in tools like Tableau/Power BI, Excel/spreadsheet modeling, Python or R for analysis (pandas, numpy), defining and tracking business metrics and KPIs, and translating data findings into clear, actionable recommendations for stakeholders.",
    sampleQuestions: ["Walk me through how you would investigate a sudden 20% drop in weekly active users using the data available to you.", "Write a SQL query to find the top 3 products by revenue in each region, and explain how you'd handle ties.", "How would you design and analyze an A/B test to measure whether a new checkout button increases conversions?", "Describe a time you turned a messy dataset into an insight that influenced a decision. What was your analysis process?"],
    evaluationEmphasis: ["sql_proficiency", "statistical_reasoning", "data_storytelling", "analytical_rigor"],
  },
  {
    slug: 'strategy', label: "Strategy / Consulting", shortLabel: 'STR', icon: '♟', category: 'business' as const, sortOrder: 20,
    description: "Consulting frameworks, problem structuring, and market analysis.",
    systemPromptContext: "The candidate is interviewing for a Strategy/Consulting role. Probe case-cracking ability, problem structuring with MECE issue trees, hypothesis-driven analysis, market sizing and estimation, profitability and growth frameworks, competitive and market-entry analysis, quantitative reasoning, synthesis into actionable client recommendations, executive-level communication, and stakeholder management. Push for structured thinking, clearly stated assumptions, and a clear so-what behind every number.",
    sampleQuestions: ["How would you estimate the annual market size for electric scooters in a major city?", "A retail client's profits are declining despite steady revenue. How would you structure your approach to find the cause?", "Walk me through how you'd advise a consumer goods company deciding whether to enter a new international market.", "Tell me about a time you used data to structure an ambiguous problem and convince others of your recommendation."],
    evaluationEmphasis: ["structured_thinking", "problem_structuring", "quantitative_reasoning", "client_communication"],
  },
  {
    slug: 'finance', label: "Finance", shortLabel: 'FIN', icon: '💰', category: 'business' as const, sortOrder: 21,
    description: "Financial statements, valuation, modeling, and capital budgeting.",
    systemPromptContext: "The candidate is interviewing for a Finance role. Probe financial statement analysis (income statement, balance sheet, cash flow linkages), valuation methods (DCF, comparable companies, precedent transactions), three-statement and LBO modeling, accounting fundamentals, capital budgeting and time value of money (NPV, IRR), ratio and variance analysis, forecasting and budgeting, working-capital management, capital markets awareness, Excel proficiency, and the ability to explain assumptions and communicate financial insights clearly to stakeholders.",
    sampleQuestions: ["Walk me through a discounted cash flow (DCF) valuation. What are the key assumptions that most affect the output?", "How do the three financial statements connect? If depreciation increases by $10, walk me through the impact on each statement.", "Tell me about a time you analyzed a company or investment. How did you structure your analysis and what did you conclude?", "How would you decide whether a company should pursue a capital project? Which metrics would you rely on?"],
    evaluationEmphasis: ["financial_acumen", "analytical_rigor", "valuation_modeling", "communication_clarity"],
  },
  {
    slug: 'operations', label: "Operations", shortLabel: 'OPS', icon: '🛠', category: 'business' as const, sortOrder: 22,
    description: "Process optimization, supply chain, KPIs, and execution.",
    systemPromptContext: "The candidate is interviewing for an Operations role. Probe process optimization and standardization, supply chain and inventory management, demand forecasting and capacity planning, vendor and supplier coordination, logistics and fulfillment, KPI tracking and operational dashboards (throughput, SLA, cycle time, cost-per-unit), root-cause analysis and process-improvement methods (Lean, Six Sigma, Kaizen, SOPs), cross-functional stakeholder coordination, and using data to identify and resolve operational bottlenecks.",
    sampleQuestions: ["Describe a process you improved. How did you identify the bottleneck and measure the impact?", "How would you track and report the operational health of a team or workflow? Which KPIs would you choose and why?", "Tell me about a time you coordinated across multiple teams or vendors to hit a deadline.", "Walk me through how you'd diagnose the root cause of a sudden drop in fulfillment or on-time delivery."],
    evaluationEmphasis: ["process_optimization", "analytical_rigor", "stakeholder_coordination", "execution_ownership"],
  },
  {
    slug: 'marketing', label: "Marketing", shortLabel: 'MKT', icon: '📣', category: 'business' as const, sortOrder: 23,
    description: "Campaigns, channels, funnel optimization, and metrics.",
    systemPromptContext: "The candidate is interviewing for a Marketing role. Probe campaign strategy and execution, audience segmentation and targeting, channel mix (SEO, SEM, paid social, email, content, organic), funnel and conversion-rate optimization, marketing analytics and attribution, A/B testing, KPIs and metrics (CAC, ROAS, CTR, engagement, retention), brand positioning and messaging, content and social strategy, and the ability to translate data into actionable campaign decisions.",
    sampleQuestions: ["Walk me through a marketing campaign you ran end to end. How did you set goals and measure success?", "A campaign's click-through rate is high but conversions are low. How would you diagnose and fix it?", "How would you decide how to split a limited budget across paid social, SEM, and email?", "How do you define and segment a target audience for a new product launch?"],
    evaluationEmphasis: ["campaign_strategy", "analytical_rigor", "channel_knowledge", "metrics_thinking"],
  },
  {
    slug: 'sales', label: "Sales", shortLabel: 'SLS', icon: '🤝', category: 'business' as const, sortOrder: 24,
    description: "Prospecting, discovery, objection handling, and closing.",
    systemPromptContext: "The candidate is interviewing for a Sales role. Probe prospecting and lead qualification (BANT/MEDDIC), discovery and needs analysis, building a value proposition, objection handling, negotiation and closing techniques, pipeline and CRM management, quota attainment, consultative and solution selling, cold outreach, relationship building, and post-sale account growth.",
    sampleQuestions: ["Walk me through how you would qualify a new lead and decide whether it's worth pursuing.", "A prospect says your product is too expensive compared to a competitor. How do you respond?", "Describe a time you turned a 'no' into a 'yes'. What changed the prospect's mind?", "How would you structure your day to hit an aggressive monthly quota with a full pipeline?"],
    evaluationEmphasis: ["persuasion_and_objection_handling", "consultative_selling", "resilience_and_drive", "pipeline_management"],
  },
  {
    slug: 'product-analyst', label: "Product Analyst", shortLabel: 'PA', icon: '📊', category: 'product' as const, sortOrder: 25,
    description: "Product metrics, experimentation, and data-driven decisions.",
    systemPromptContext: "The candidate is interviewing for a Product Analyst role. Probe product metric definition (activation, retention, funnels, North Star), SQL and data querying, event instrumentation and tracking plans, A/B test design and statistical-significance reasoning, cohort and funnel analysis, dashboarding (Amplitude, Mixpanel, Looker, Tableau), and translating data into product recommendations and stakeholder-ready insights.",
    sampleQuestions: ["A key feature's weekly active users dropped 15%. How would you investigate the cause?", "How would you define and measure success for a new onboarding flow?", "Walk me through how you'd design and read out an A/B test for a checkout change.", "Tell me about an analysis you ran that changed a product decision."],
    evaluationEmphasis: ["analytical_rigor", "metrics_thinking", "sql_proficiency", "product_sense"],
  },
  {
    slug: 'ui-designer', label: "UI Designer", shortLabel: 'UI', icon: '🎨', category: 'product' as const, sortOrder: 26,
    description: "Visual design, design systems, prototyping, and accessibility.",
    systemPromptContext: "The candidate is interviewing for a UI Designer role. Probe visual design fundamentals (typography, color theory, layout, spacing, visual hierarchy), interaction and component design, design systems and reusable component libraries, Figma proficiency and prototyping, responsive and mobile-first design, accessibility (WCAG, contrast, keyboard navigation), design-to-developer handoff, and how they iterate on a UI based on user feedback and usability testing.",
    sampleQuestions: ["Walk me through a UI you designed end to end. How did you establish the visual hierarchy and what tradeoffs did you make?", "How would you design a consistent component library, and how do you decide when to create a new component versus reuse an existing one?", "A stakeholder says your screen 'looks cluttered.' How would you diagnose and fix the problem?", "How do you make sure your designs are accessible and translate cleanly when you hand them off to engineers?"],
    evaluationEmphasis: ["visual_design_fundamentals", "interaction_design", "design_systems", "attention_to_detail"],
  },
  {
    slug: 'product-designer', label: "Product Designer", shortLabel: 'PD', icon: '✏', category: 'product' as const, sortOrder: 27,
    description: "End-to-end UX — research, IA, interaction, and prototyping.",
    systemPromptContext: "The candidate is interviewing for a Product Designer role. Probe end-to-end UX process, user research and usability testing, persona and journey mapping, information architecture, wireframing and prototyping (Figma), interaction and visual design, design systems and component libraries, accessibility (WCAG), responsive/mobile patterns, design critique and iteration based on feedback, cross-functional collaboration with PMs and engineers, and how design decisions are validated against user needs and product metrics.",
    sampleQuestions: ["Walk me through a project in your portfolio from initial problem to final design. What user research informed your decisions?", "How would you redesign a checkout flow that has a high drop-off rate? What would you measure to know it improved?", "Tell me about a time stakeholder or engineering feedback conflicted with your design vision. How did you handle it?", "How do you approach designing for accessibility and across different screen sizes?"],
    evaluationEmphasis: ["user_centered_thinking", "design_process", "visual_communication", "cross_functional_collaboration"],
  },
]

const BUILT_IN_DEPTHS = [
  {
    slug: 'behavioral', label: 'Behavioral Interview', icon: '🧠', sortOrder: 1,
    description: 'Behavioral probing — motivation, leadership, conflict resolution, self-awareness, and culture fit.',
    systemPromptTemplate: 'You are Alex Chen, a senior interviewer conducting a {duration}-minute behavioral interview for a {domain} role ({experience} years experience). Start warm and conversational, then dig deeper into past experiences with multi-layered follow-ups.',
    questionStrategy: 'Start with motivation and culture-fit questions, then probe deeper into leadership scenarios, conflict resolution, failure recovery, team dynamics, and ethical dilemmas. Rotate through: behavioral (STAR), motivation, situational, and consistency checks. Challenge vague answers with follow-ups.',
    evaluationCriteria: 'Evaluate STAR structure, ownership language, specificity of examples, depth of reflection, self-awareness, growth mindset, leadership signal, and cultural fit signals.',
    avatarPersona: 'Warm but thorough interviewer. Starts encouraging and conversational, then digs deep. Asks "tell me more" and "what would you do differently?"',
    scoringDimensions: [
      { name: 'relevance', label: 'Relevance', weight: 0.15 },
      { name: 'structure', label: 'STAR Structure', weight: 0.25 },
      { name: 'specificity', label: 'Specificity', weight: 0.20 },
      { name: 'ownership', label: 'Ownership', weight: 0.20 },
      { name: 'self_awareness', label: 'Self-Awareness', weight: 0.20 },
    ],
    applicableDomains: [],
    applicableCategories: [],
  },
  {
    slug: 'technical', label: 'Technical Deep Dive', icon: '⚙️', sortOrder: 2,
    description: 'Domain-specific technical depth — knowledge, problem-solving, trends, and practical application.',
    systemPromptTemplate: 'You are Alex Chen, a technical interviewer conducting a {duration}-minute technical interview for a {domain} role ({experience} years experience). Test technical depth, domain knowledge, and problem-solving ability through scenario-based questions.',
    questionStrategy: 'Ask domain-specific technical questions and industry knowledge probes. For engineering: system design, architecture, debugging, tooling. For PM: metrics, estimation, technical tradeoffs. For DS: statistics, ML, experiment design. For business: frameworks, quantitative reasoning. Also test industry trends, best practices, and practical application. Adapt to the domain.',
    evaluationCriteria: 'Evaluate technical accuracy, depth of knowledge, problem-solving approach, awareness of current trends, and ability to communicate technical concepts clearly.',
    avatarPersona: 'Technical interviewer who is collaborative but expects rigor. Engages in professional dialogue about domain expertise.',
    scoringDimensions: [
      { name: 'technical_accuracy', label: 'Technical Accuracy', weight: 0.25 },
      { name: 'depth', label: 'Depth of Knowledge', weight: 0.25 },
      { name: 'problem_solving', label: 'Problem Solving', weight: 0.25 },
      { name: 'communication', label: 'Technical Communication', weight: 0.25 },
    ],
    applicableDomains: [],
    applicableCategories: [],
  },
  {
    slug: 'case-study', label: 'Case Study', icon: '📋', sortOrder: 3,
    description: 'Scenario-based problem-solving — structured thinking, frameworks, and business reasoning.',
    systemPromptTemplate: 'You are Alex Chen, conducting a {duration}-minute case study interview for a {domain} role ({experience} years experience). Present realistic business or technical scenarios and evaluate the candidate\'s structured approach.',
    questionStrategy: 'Present scenarios relevant to the domain. Guide the candidate through a structured case: clarifying questions → framework → analysis → recommendation. Provide data points when asked. For engineering domains, use system-design or debugging scenarios instead of business cases.',
    evaluationCriteria: 'Evaluate framework usage, structured thinking, ability to ask clarifying questions, quantitative reasoning, and quality of final recommendation.',
    avatarPersona: 'Case interviewer who sets up scenarios and lets the candidate drive. Provides hints when stuck but expects structured thinking.',
    scoringDimensions: [
      { name: 'framework_usage', label: 'Framework Usage', weight: 0.25 },
      { name: 'structured_thinking', label: 'Structured Thinking', weight: 0.25 },
      { name: 'quantitative_reasoning', label: 'Quantitative Reasoning', weight: 0.25 },
      { name: 'recommendation_quality', label: 'Recommendation Quality', weight: 0.25 },
    ],
    applicableDomains: ['pm', 'business', 'data-science', 'design', 'general'],
    applicableCategories: ['product', 'business', 'data-ai', 'design'],
  },
  {
    slug: 'system-design', label: 'System Design', icon: '🏗️', sortOrder: 4,
    description: 'Architecture and system design — scalability, trade-offs, data modeling, and distributed systems.',
    systemPromptTemplate: 'You are Alex Chen, a senior technical interviewer conducting a {duration}-minute system design interview for a {domain} role ({experience} years experience). Present a system design problem and guide the candidate through requirements gathering, high-level design, deep dives, and trade-off discussions.',
    questionStrategy: 'Present ONE system design problem. Let the candidate drive: requirements clarification → high-level architecture → component deep-dive → scaling discussion → trade-offs. Probe on: data modeling, API design, caching strategy, database selection, consistency vs availability, failure handling, monitoring. Ask "what happens when X fails?" and "how would you scale this 10x?"',
    evaluationCriteria: 'Evaluate ability to clarify requirements, propose sensible architecture, reason about scalability and trade-offs, make justified technology choices, and communicate design decisions clearly.',
    avatarPersona: 'Collaborative senior architect who sets up the problem and lets the candidate lead. Provides constraints when asked and probes on weak areas.',
    scoringDimensions: [
      { name: 'requirements_clarity', label: 'Requirements Gathering', weight: 0.15 },
      { name: 'architecture', label: 'Architecture Design', weight: 0.25 },
      { name: 'scalability', label: 'Scalability Reasoning', weight: 0.25 },
      { name: 'tradeoffs', label: 'Trade-off Analysis', weight: 0.20 },
      { name: 'communication', label: 'Design Communication', weight: 0.15 },
    ],
    applicableDomains: ['backend', 'frontend', 'sdet', 'data-science', 'general'],
    applicableCategories: ['programming', 'data-ai'],
  },
  {
    slug: 'coding', label: 'Coding Challenge', icon: '💻', sortOrder: 5,
    description: 'Live coding problem-solving — algorithm design, implementation, testing, and optimization.',
    systemPromptTemplate: 'You are Alex Chen, a senior technical interviewer conducting a {duration}-minute coding interview for a {domain} role ({experience} years experience). Present a coding problem, let the candidate ask clarifying questions, then evaluate their code solution.',
    questionStrategy: 'Present ONE coding problem at a time. Let the candidate clarify requirements, discuss approach, implement the solution, and explain trade-offs. Ask about time/space complexity. Ask "what edge cases should we handle?" and "how would you optimize this?"',
    evaluationCriteria: 'Evaluate correctness (does it work for all cases), code quality (readability, naming, structure), algorithmic efficiency (time/space complexity), edge case handling, and ability to communicate their approach clearly.',
    avatarPersona: 'Collaborative technical interviewer who sets up the problem and lets the candidate drive. Provides hints on syntax but probes on algorithmic thinking and trade-offs.',
    scoringDimensions: [
      { name: 'correctness', label: 'Correctness', weight: 0.30 },
      { name: 'efficiency', label: 'Efficiency (Time/Space)', weight: 0.25 },
      { name: 'code_quality', label: 'Code Quality & Style', weight: 0.20 },
      { name: 'communication', label: 'Communication', weight: 0.15 },
      { name: 'edge_cases', label: 'Edge Cases & Testing', weight: 0.10 },
    ],
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    applicableCategories: ['programming', 'data-ai'],
  },
  {
    slug: 'academics', label: 'Academics', icon: '📚', sortOrder: 6,
    description: 'Campus-style academics round — name your strongest subject, then get grilled on its fundamentals, theorems/frameworks, and adjacent subjects. For freshers (0-2 yrs).',
    systemPromptTemplate: 'You are Alex Chen, a campus-placement panel interviewer conducting a {duration}-minute academic / subject viva for a {domain} fresher ({experience} years experience). Open by asking which academic subject they are strongest in or enjoy most, then drill that subject\'s fundamentals — definitions, derivations, theorems/frameworks, and the assumptions behind them — before moving to an adjacent subject. Test genuine understanding from first principles, one concept at a time.',
    questionStrategy: 'Open by asking the candidate to name their favourite / strongest subject and why. Anchor the first third of the viva there: start with a core fundamental, then push to the mechanism, derivation, or "why", then test the edge of their understanding. Ask them to explain or derive — never just define. Once their favourite subject is well explored, bridge to an adjacent subject (per the domain skill map) to test breadth. Stay strictly on the standard, widely-taught syllabus — never obscure trivia or a specific paper. Accept "I would look it up" for a specific constant/value; reward first-principles reasoning over rote recall. When the candidate is wrong, correct gently with the standard result. One concept at a time.',
    evaluationCriteria: 'Evaluate conceptual correctness (is the fundamental right), depth of understanding (can they explain the mechanism and derive it, not just recite), reasoning / derivation from first principles (with stated assumptions), and breadth across adjacent subjects. Reward intellectual honesty ("I am not sure, but reasoning from first principles…") over confident wrong recall. Do not penalize a minor arithmetic slip if the method is sound; do not reward buzzwords without understanding. This is a subject viva, NOT a behavioral interview — do not expect or reward STAR structure.',
    avatarPersona: 'A campus viva panelist — equal parts professor and practitioner. Warm but probing; asks "why" and "derive that" rather than accepting a definition. Corrects gently and keeps drilling to find the edge of understanding.',
    scoringDimensions: [
      { name: 'correctness', label: 'Conceptual Correctness', weight: 0.35 },
      { name: 'conceptual_depth', label: 'Depth of Understanding', weight: 0.30 },
      { name: 'derivation', label: 'Reasoning & Derivation', weight: 0.20 },
      { name: 'breadth', label: 'Breadth Across Subjects', weight: 0.15 },
    ],
    applicableDomains: [],
    applicableCategories: ['programming', 'data-ai', 'core-engineering', 'business'],
    applicableExperience: ['0-2'],
  },
]

export async function seedDatabase() {
  await connectDB()

  const currentCategorySlugs = BUILT_IN_CATEGORIES.map(c => c.slug)
  const currentDomainSlugs = BUILT_IN_DOMAINS.map(d => d.slug)
  const currentDepthSlugs = BUILT_IN_DEPTHS.map(d => d.slug)

  // Upsert categories
  for (const category of BUILT_IN_CATEGORIES) {
    await Category.findOneAndUpdate(
      { slug: category.slug },
      { ...category, isBuiltIn: true, isActive: true },
      { upsert: true, returnDocument: 'after' }
    )
  }

  // Deactivate old built-in categories no longer in the list
  await Category.updateMany(
    { isBuiltIn: true, slug: { $nin: currentCategorySlugs } },
    { isActive: false }
  )

  // Upsert domains (inject the data-driven categorySlug; legacy `category` kept)
  for (const domain of BUILT_IN_DOMAINS) {
    await InterviewDomain.findOneAndUpdate(
      { slug: domain.slug },
      { ...domain, categorySlug: categorySlugFor(domain.slug), isBuiltIn: true, isActive: true },
      { upsert: true, returnDocument: 'after' }
    )
  }

  // Deactivate old built-in domains no longer in the list
  await InterviewDomain.updateMany(
    { isBuiltIn: true, slug: { $nin: currentDomainSlugs } },
    { isActive: false }
  )

  // Upsert depths
  for (const depth of BUILT_IN_DEPTHS) {
    await InterviewDepth.findOneAndUpdate(
      { slug: depth.slug },
      { ...depth, isBuiltIn: true, isActive: true },
      { upsert: true, returnDocument: 'after' }
    )
  }

  // Deactivate old built-in depths no longer in the list
  await InterviewDepth.updateMany(
    { isBuiltIn: true, slug: { $nin: currentDepthSlugs } },
    { isActive: false }
  )

  return {
    categories: BUILT_IN_CATEGORIES.length,
    domains: BUILT_IN_DOMAINS.length,
    depths: BUILT_IN_DEPTHS.length,
  }
}

// Fallback data for when DB is not available (used by public APIs)
export const FALLBACK_CATEGORIES = BUILT_IN_CATEGORIES.map(c => ({ ...c }))

export const FALLBACK_DOMAINS = BUILT_IN_DOMAINS.map(d => ({
  slug: d.slug,
  label: d.label,
  shortLabel: d.shortLabel,
  icon: d.icon,
  description: d.description,
  color: 'indigo',
  category: d.category,
  categorySlug: categorySlugFor(d.slug),
  systemPromptContext: d.systemPromptContext,
}))

export const FALLBACK_DEPTHS = BUILT_IN_DEPTHS.map(d => ({
  slug: d.slug,
  label: d.label,
  icon: d.icon,
  description: d.description,
  scoringDimensions: d.scoringDimensions,
  systemPromptTemplate: d.systemPromptTemplate,
  questionStrategy: d.questionStrategy,
  evaluationCriteria: d.evaluationCriteria,
  avatarPersona: d.avatarPersona,
  applicableDomains: d.applicableDomains as string[],
  applicableCategories: (d.applicableCategories ?? []) as string[],
  applicableExperience: ((d as { applicableExperience?: string[] }).applicableExperience ?? []) as string[],
}))
