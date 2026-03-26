import type { PoolQuestion } from './types'

export const devopsQuestions: Record<string, PoolQuestion[]> = {
  'devops:screening': [
    { question: 'What drew you to infrastructure and DevOps work?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'learning projects' },
    { question: 'How do you think about the difference between DevOps culture and DevOps tooling?', experience: '0-2', targetCompetency: 'culture_understanding', followUpTheme: 'practical examples' },
    { question: 'What is your philosophy on toil reduction and automation?', experience: '3-6', targetCompetency: 'automation_mindset', followUpTheme: 'ROI of automation' },
    { question: 'How do you balance feature velocity with operational stability?', experience: '3-6', targetCompetency: 'strategic_balance', followUpTheme: 'real tradeoffs' },
    { question: 'What does a mature platform engineering organization look like to you?', experience: '7+', targetCompetency: 'vision', followUpTheme: 'building toward it' },
    { question: 'How do you measure the success of a DevOps or SRE team?', experience: '7+', targetCompetency: 'metrics_thinking', followUpTheme: 'business alignment' },
    { question: 'What is the most satisfying automation you have built?', experience: 'all', targetCompetency: 'craft_passion', followUpTheme: 'impact measurement' },
  ],
  'devops:behavioral': [
    { question: 'Tell me about your first on-call experience. What surprised you?', experience: '0-2', targetCompetency: 'resilience', followUpTheme: 'learning from it' },
    { question: 'Describe a manual process you automated and what impact it had.', experience: '0-2', targetCompetency: 'initiative', followUpTheme: 'adoption by team' },
    { question: 'Tell me about a major incident you led the response for. Walk me through your approach.', experience: '3-6', targetCompetency: 'incident_leadership', followUpTheme: 'post-mortem and prevention' },
    { question: 'Describe a time you advocated for reliability investment when the team wanted to ship features.', experience: '3-6', targetCompetency: 'influence', followUpTheme: 'framing the argument' },
    { question: 'Tell me about how you established blameless post-mortem culture in an organization.', experience: '7+', targetCompetency: 'culture_building', followUpTheme: 'overcoming resistance' },
    { question: 'Describe a time you had to make a difficult call during an outage with incomplete information.', experience: '7+', targetCompetency: 'crisis_leadership', followUpTheme: 'decision framework' },
    { question: 'Tell me about a time on-call burnout affected your team. How did you address it?', experience: 'all', targetCompetency: 'team_wellbeing', followUpTheme: 'sustainable practices' },
  ],
  'devops:technical': [
    { question: 'How would you design a basic CI/CD pipeline for a team of five developers?', experience: '0-2', targetCompetency: 'cicd_design', followUpTheme: 'testing integration' },
    { question: 'Explain the difference between containers and VMs. When would you choose each?', experience: '0-2', targetCompetency: 'infrastructure_fundamentals', followUpTheme: 'production considerations' },
    { question: 'How would you design an observability stack for a platform running 50 microservices?', experience: '3-6', targetCompetency: 'observability', followUpTheme: 'alerting philosophy' },
    { question: 'Walk me through your approach to designing SLOs for a customer-facing API.', experience: '3-6', targetCompetency: 'reliability_engineering', followUpTheme: 'error budgets' },
    { question: 'How would you design an internal developer platform for a 200-person engineering org?', experience: '7+', targetCompetency: 'platform_engineering', followUpTheme: 'self-service model' },
    { question: 'What is your approach to FinOps and cost optimization in cloud infrastructure?', experience: '7+', targetCompetency: 'cost_engineering', followUpTheme: 'org-wide adoption' },
    { question: 'How do you approach infrastructure-as-code for a multi-environment setup?', experience: 'all', targetCompetency: 'iac', followUpTheme: 'drift detection' },
  ],
  'devops:case-study': [
    { question: 'Design a zero-downtime deployment pipeline for a web application with a database.', experience: '0-2', targetCompetency: 'deployment_design', followUpTheme: 'rollback strategy' },
    { question: 'Your team needs to set up monitoring for a new service. Design the observability approach.', experience: '0-2', targetCompetency: 'monitoring_design', followUpTheme: 'alert thresholds' },
    { question: 'Design a disaster recovery strategy for a financial services platform with a 15-minute RTO.', experience: '3-6', targetCompetency: 'dr_design', followUpTheme: 'testing the DR plan' },
    { question: 'Plan a cloud migration for a legacy on-premises monolith used by 500 internal users.', experience: '3-6', targetCompetency: 'migration_planning', followUpTheme: 'phasing and risk' },
    { question: 'Architect a multi-region active-active infrastructure for a global SaaS platform.', experience: '7+', targetCompetency: 'global_architecture', followUpTheme: 'data consistency across regions' },
    { question: 'Design an incident response system including tooling, processes, and team structure.', experience: '7+', targetCompetency: 'incident_system_design', followUpTheme: 'metrics and improvement' },
    { question: 'Production is down. Walk me through your first 15 minutes of incident response.', experience: 'all', targetCompetency: 'incident_response', followUpTheme: 'communication and escalation' },
  ],
}
