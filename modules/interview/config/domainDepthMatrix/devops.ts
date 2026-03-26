import type { DomainDepthOverride } from './types'

export const devopsOverrides: Record<string, DomainDepthOverride> = {
  'devops:screening': {
    questionStrategy: 'Probe motivation for infrastructure and reliability work, interest in automation, culture fit for ops-minded teams. Ask about their approach to toil reduction, what excites them about cloud infrastructure, and how they view the DevOps/SRE role.',
    interviewerTone: 'Pragmatic and systems-oriented. Show interest in their operational philosophy.',
    scoringEmphasis: 'Evaluate passion for automation, communication about reliability principles, culture fit for on-call and incident-driven teams, and understanding of DevOps culture.',
    sampleOpeners: [
      'What drew you to DevOps/SRE work?',
      'How do you think about the balance between new features and reliability?',
    ],
  },
  'devops:behavioral': {
    questionStrategy: 'Explore scenarios around managing major incidents, making decisions during outages, driving post-mortem culture, handling on-call burnout, advocating for reliability investment, and navigating tension between dev velocity and operational stability.',
    interviewerTone: 'Experienced ops leader who understands the unique pressures of infrastructure work — on-call stress, incident fatigue, and the challenge of invisible work.',
    scoringEmphasis: 'Evaluate incident leadership, blameless culture advocacy, ability to influence engineering practices, resilience under operational pressure, and growth from incidents.',
    sampleOpeners: [
      'Tell me about the most impactful incident you managed. Walk me through your role.',
      'Describe a time you had to convince engineering leadership to invest in reliability over features.',
    ],
  },
  'devops:technical': {
    questionStrategy: 'Deep-dive into CI/CD pipeline design, infrastructure-as-code (Terraform, Pulumi), container orchestration (Kubernetes), cloud architecture (AWS/GCP/Azure), monitoring and observability (Prometheus, Grafana, DataDog), SLO/SLI/SLA design, and chaos engineering.',
    interviewerTone: 'Collaborative infrastructure architect. Discuss design philosophy and tradeoffs, not just tool proficiency.',
    technicalTranslation: 'Technical means: infrastructure architecture, CI/CD design, container orchestration, cloud platform expertise, observability systems, and reliability engineering practices.',
    scoringEmphasis: 'Evaluate infrastructure design thinking, understanding of reliability principles (SLOs, error budgets), ability to reason about cost vs. reliability tradeoffs, and depth of cloud platform experience.',
    sampleOpeners: [
      'How would you design an observability stack for a platform running 200 microservices?',
      'Walk me through your approach to designing SLOs for a customer-facing API.',
    ],
  },
  'devops:case-study': {
    questionStrategy: 'Present infrastructure scenarios: design a zero-downtime deployment pipeline, architect a multi-region disaster recovery system, plan a cloud migration for a legacy on-premises platform, or design an incident response system.',
    interviewerTone: 'Infrastructure architect who presents realistic constraints around budget, team size, legacy systems, and compliance requirements.',
    technicalTranslation: 'Case study means: infrastructure architecture design, migration planning, reliability system design, and operational process architecture.',
    scoringEmphasis: 'Evaluate structured approach to infrastructure design, cost-awareness, consideration of failure modes, operational runbook thinking, and ability to phase complex migrations.',
    sampleOpeners: [
      'Design a disaster recovery strategy for a financial services platform with a 15-minute RTO.',
      'Plan the migration of a 10-year-old on-premises monolith to cloud-native architecture.',
    ],
  },
}
