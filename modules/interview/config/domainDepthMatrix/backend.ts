import type { DomainDepthOverride } from './types'

export const backendOverrides: Record<string, DomainDepthOverride> = {
  'backend:screening': {
    questionStrategy: 'Probe motivation for backend/systems work, interest in scalability and reliability, and culture fit for engineering organizations. Ask about their approach to building robust systems, what excites them about distributed computing, and career trajectory.',
    interviewerTone: 'Professional and systems-minded. Show interest in their architectural thinking even during a screening.',
    scoringEmphasis: 'Evaluate communication clarity about technical concepts, genuine interest in backend challenges, culture fit for engineering teams, and ability to articulate system-level thinking.',
    antiPatterns: 'Do NOT ask deep system design questions or whiteboard architecture — this is a screening, not a technical round. Focus on motivation, communication, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect enthusiasm for building things, basic awareness of databases and APIs, and evidence of self-driven learning through side projects or coursework.',
      '3-6': 'Expect clear articulation of systems they have built, awareness of scalability concepts, and concrete career direction in backend/infrastructure.',
      '7+': 'Expect strategic perspective on engineering culture, team building philosophy, and ability to connect backend architecture decisions to business outcomes.',
    },
    domainRedFlags: [
      'Cannot describe any system they have built or contributed to beyond trivial CRUD',
      'Shows no interest in reliability, scalability, or operational concerns',
      'Unable to explain technical concepts in plain language',
    ],
  },
  'backend:behavioral': {
    questionStrategy: 'Explore leadership in backend-specific scenarios: managing production incidents under pressure, making build-vs-buy decisions, handling tech debt prioritization, navigating cross-team API contract negotiations, and mentoring on system design.',
    interviewerTone: 'Thoughtful and probing. Dig into decision-making during high-stakes technical situations — outages, data migrations, architectural pivots.',
    scoringEmphasis: 'Evaluate incident leadership maturity, ability to balance speed vs reliability, self-awareness about past architectural decisions, and growth from production failures.',
    antiPatterns: 'Do NOT quiz on distributed systems theory or ask to design systems on the spot. Behavioral rounds focus on decision-making under pressure, leadership, and learning from failures.',
    experienceCalibration: {
      '0-2': 'Expect stories from early career: first production bugs, learning to work with senior engineers, handling their first on-call rotation or deployment.',
      '3-6': 'Expect ownership narratives: leading incident responses, making build-vs-buy decisions, driving tech debt conversations, and navigating cross-team dependencies.',
      '7+': 'Expect organizational impact stories: establishing engineering standards, mentoring teams through architectural transitions, and making strategic technical bets.',
    },
    domainRedFlags: [
      'Cannot describe any production incident or operational challenge they have faced',
      'Takes no ownership of failures — always blames external factors or other teams',
      'No evidence of learning or growth from past technical decisions',
    ],
  },
  'backend:technical': {
    questionStrategy: 'Deep-dive into API design (REST, GraphQL, gRPC), database modeling and query optimization, distributed systems (consistency models, CAP theorem, event-driven architecture), caching strategies, message queues, microservices patterns, and observability/monitoring.',
    interviewerTone: 'Collaborative senior engineer. Engage in architectural dialogue, ask follow-ups on tradeoffs rather than looking for textbook answers.',
    technicalTranslation: 'Technical means: system design, database architecture, API design patterns, distributed systems concepts, scalability strategies, and infrastructure choices.',
    scoringEmphasis: 'Evaluate depth of distributed systems understanding, ability to reason about consistency/availability tradeoffs, database modeling skills, and practical experience scaling systems.',
    antiPatterns: 'Do NOT ask frontend questions, UI design problems, or product strategy. Technical for backend means APIs, databases, distributed systems, and infrastructure architecture.',
    experienceCalibration: {
      '0-2': 'Expect solid fundamentals: REST API design, basic SQL/NoSQL usage, understanding of HTTP and networking basics. Probe for curiosity about how systems work under the hood.',
      '3-6': 'Expect production experience: database optimization, caching strategies, message queue usage, microservices patterns, and debugging distributed systems in production.',
      '7+': 'Expect architectural leadership: designing for scale, evaluating consistency models, capacity planning, defining API contracts across teams, and mentoring on system design.',
    },
    domainRedFlags: [
      'Cannot explain the tradeoffs between SQL and NoSQL databases for a given use case',
      'No experience with production systems — only theoretical knowledge',
      'Unable to describe how they would debug a performance issue in a distributed system',
      'Treats all scalability problems with the same solution regardless of constraints',
    ],
  },
  'backend:case-study': {
    questionStrategy: 'Present system design scenarios: design a notification service, architect an event-sourcing pipeline, plan a monolith-to-microservices migration, design a real-time analytics system, or build a multi-tenant SaaS platform.',
    interviewerTone: 'System design interviewer who provides constraints incrementally. Start simple, add scale and complexity as the candidate progresses.',
    technicalTranslation: 'Case study means: full system design exercises with real-world constraints around scale, cost, reliability, and team structure.',
    scoringEmphasis: 'Evaluate structured approach to system design, ability to make and justify tradeoffs, consideration of operational concerns (monitoring, deployment, failure modes), and capacity estimation skills.',
    antiPatterns: 'Do NOT present vague open-ended prompts without constraints. Case studies for backend should have concrete scale numbers, team size, timeline, and business context to ground the discussion.',
    experienceCalibration: {
      '0-2': 'Expect basic system decomposition: client-server model, single database, simple caching. Guide through constraints and look for structured thinking.',
      '3-6': 'Expect multi-service design with caching layers, async processing, database sharding awareness, and consideration of failure modes and monitoring.',
      '7+': 'Expect end-to-end system thinking: capacity estimation, cost analysis, phased rollout plans, organizational considerations, and operational runbook design.',
    },
    domainRedFlags: [
      'Cannot estimate order-of-magnitude capacity requirements',
      'Designs only for the happy path with no consideration of failure modes',
      'No mention of monitoring, alerting, or operational concerns',
    ],
  },
}
