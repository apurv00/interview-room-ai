import type { DomainDepthOverride } from './types'

export const backendOverrides: Record<string, DomainDepthOverride> = {
  'backend:screening': {
    questionStrategy: 'Probe motivation for backend/systems work, interest in scalability and reliability, and culture fit for engineering organizations. Ask about their approach to building robust systems, what excites them about distributed computing, and career trajectory.',
    interviewerTone: 'Professional and systems-minded. Show interest in their architectural thinking even during a screening.',
    scoringEmphasis: 'Evaluate communication clarity about technical concepts, genuine interest in backend challenges, culture fit for engineering teams, and ability to articulate system-level thinking.',
    sampleOpeners: [
      'What draws you to backend engineering over other specialties?',
      'Tell me about the most interesting system you have worked on.',
    ],
  },
  'backend:behavioral': {
    questionStrategy: 'Explore leadership in backend-specific scenarios: managing production incidents under pressure, making build-vs-buy decisions, handling tech debt prioritization, navigating cross-team API contract negotiations, and mentoring on system design.',
    interviewerTone: 'Thoughtful and probing. Dig into decision-making during high-stakes technical situations — outages, data migrations, architectural pivots.',
    scoringEmphasis: 'Evaluate incident leadership maturity, ability to balance speed vs reliability, self-awareness about past architectural decisions, and growth from production failures.',
    sampleOpeners: [
      'Tell me about a production incident where you led the response. What happened and what did you learn?',
      'Describe a time you had to convince your team to take on significant tech debt refactoring.',
    ],
  },
  'backend:technical': {
    questionStrategy: 'Deep-dive into API design (REST, GraphQL, gRPC), database modeling and query optimization, distributed systems (consistency models, CAP theorem, event-driven architecture), caching strategies, message queues, microservices patterns, and observability/monitoring.',
    interviewerTone: 'Collaborative senior engineer. Engage in architectural dialogue, ask follow-ups on tradeoffs rather than looking for textbook answers.',
    technicalTranslation: 'Technical means: system design, database architecture, API design patterns, distributed systems concepts, scalability strategies, and infrastructure choices.',
    scoringEmphasis: 'Evaluate depth of distributed systems understanding, ability to reason about consistency/availability tradeoffs, database modeling skills, and practical experience scaling systems.',
    sampleOpeners: [
      'How would you design the data model and API for a rate-limiting service that needs to handle 100K requests per second?',
      'Walk me through your approach to debugging a latency spike in a microservices architecture.',
    ],
  },
  'backend:case-study': {
    questionStrategy: 'Present system design scenarios: design a notification service, architect an event-sourcing pipeline, plan a monolith-to-microservices migration, design a real-time analytics system, or build a multi-tenant SaaS platform.',
    interviewerTone: 'System design interviewer who provides constraints incrementally. Start simple, add scale and complexity as the candidate progresses.',
    technicalTranslation: 'Case study means: full system design exercises with real-world constraints around scale, cost, reliability, and team structure.',
    scoringEmphasis: 'Evaluate structured approach to system design, ability to make and justify tradeoffs, consideration of operational concerns (monitoring, deployment, failure modes), and capacity estimation skills.',
    sampleOpeners: [
      'Design a URL shortening service that handles 10M new URLs per day. Start with the basics and we will add complexity.',
      'Your company needs to migrate from a monolithic Rails app to microservices. Walk me through your approach.',
    ],
  },
}
