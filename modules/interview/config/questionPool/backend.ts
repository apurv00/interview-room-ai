import type { PoolQuestion } from './types'

export const backendQuestions: Record<string, PoolQuestion[]> = {
  'backend:screening': [
    { question: 'What got you interested in backend engineering?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'learning path' },
    { question: 'Tell me about the most interesting system you have worked on.', experience: '0-2', targetCompetency: 'technical_curiosity', followUpTheme: 'your contribution' },
    { question: 'How do you think about the tradeoff between moving fast and building reliable systems?', experience: '3-6', targetCompetency: 'engineering_judgment', followUpTheme: 'real examples' },
    { question: 'What draws you to distributed systems challenges?', experience: '3-6', targetCompetency: 'passion', followUpTheme: 'specific problems solved' },
    { question: 'How do you think about the backend engineer role at the staff or principal level?', experience: '7+', targetCompetency: 'career_vision', followUpTheme: 'leadership style' },
    { question: 'What is your philosophy on building systems that outlast the team that created them?', experience: '7+', targetCompetency: 'strategic_thinking', followUpTheme: 'documentation and design' },
    { question: 'What kind of backend problems energize you the most?', experience: 'all', targetCompetency: 'passion', followUpTheme: 'concrete examples' },
  ],
  'backend:behavioral': [
    { question: 'Tell me about your first production incident. What happened and what did you learn?', experience: '0-2', targetCompetency: 'incident_learning', followUpTheme: 'growth from failure' },
    { question: 'Describe a time you had to debug a tricky issue across multiple services.', experience: '0-2', targetCompetency: 'debugging', followUpTheme: 'methodology used' },
    { question: 'Tell me about a build-vs-buy decision you influenced. Walk me through your reasoning.', experience: '3-6', targetCompetency: 'decision_making', followUpTheme: 'outcome and retrospective' },
    { question: 'Describe a time you had to negotiate API contracts with another team that had conflicting requirements.', experience: '3-6', targetCompetency: 'cross_team_collaboration', followUpTheme: 'resolution approach' },
    { question: 'Tell me about a time you drove a major architectural change across your organization.', experience: '7+', targetCompetency: 'technical_leadership', followUpTheme: 'stakeholder management' },
    { question: 'How did you handle a situation where technical debt was threatening system reliability?', experience: '7+', targetCompetency: 'strategic_prioritization', followUpTheme: 'business alignment' },
    { question: 'Describe a production incident where you led the response. What was your approach?', experience: 'all', targetCompetency: 'incident_leadership', followUpTheme: 'process improvements after' },
  ],
  'backend:technical': [
    { question: 'How would you design a REST API for a task management system? What resources and endpoints?', experience: '0-2', targetCompetency: 'api_design', followUpTheme: 'error handling patterns' },
    { question: 'When would you choose a NoSQL database over a relational one? Give me a concrete example.', experience: '0-2', targetCompetency: 'database_design', followUpTheme: 'consistency tradeoffs' },
    { question: 'How would you design a rate-limiting service that handles 100K requests per second?', experience: '3-6', targetCompetency: 'system_design', followUpTheme: 'distributed coordination' },
    { question: 'Walk me through how you would diagnose a latency spike in a microservices architecture.', experience: '3-6', targetCompetency: 'debugging', followUpTheme: 'observability strategy' },
    { question: 'How do you approach designing for eventual consistency in a distributed system?', experience: '7+', targetCompetency: 'distributed_systems', followUpTheme: 'business impact of consistency choices' },
    { question: 'What is your framework for deciding when to split a monolith into services?', experience: '7+', targetCompetency: 'architecture_strategy', followUpTheme: 'team and org implications' },
    { question: 'How do you approach caching in a system with multiple data sources?', experience: 'all', targetCompetency: 'caching_strategy', followUpTheme: 'invalidation approaches' },
  ],
  'backend:case-study': [
    { question: 'Design a URL shortening service. Start with the basics and we will add complexity.', experience: '0-2', targetCompetency: 'system_design', followUpTheme: 'scaling considerations' },
    { question: 'Design a notification service that supports email, push, and SMS channels.', experience: '0-2', targetCompetency: 'system_design', followUpTheme: 'reliability and retry logic' },
    { question: 'Architect an event-sourcing pipeline for an e-commerce order management system.', experience: '3-6', targetCompetency: 'event_architecture', followUpTheme: 'replay and consistency' },
    { question: 'Design a real-time analytics dashboard that processes 1M events per minute.', experience: '3-6', targetCompetency: 'data_pipeline_design', followUpTheme: 'latency vs accuracy tradeoff' },
    { question: 'Plan a monolith-to-microservices migration for a 10-year-old e-commerce platform.', experience: '7+', targetCompetency: 'migration_strategy', followUpTheme: 'phasing and risk mitigation' },
    { question: 'Design a multi-tenant SaaS platform where tenants have different data residency requirements.', experience: '7+', targetCompetency: 'platform_architecture', followUpTheme: 'compliance and isolation' },
    { question: 'A critical database query is taking 30 seconds. Walk me through your investigation.', experience: 'all', targetCompetency: 'performance_debugging', followUpTheme: 'systematic methodology' },
  ],
}
