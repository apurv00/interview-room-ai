import type { DomainDepthOverride } from './types'

export const devopsOverrides: Record<string, DomainDepthOverride> = {
  'devops:screening': {
    questionStrategy: 'Probe motivation for infrastructure and reliability work, interest in automation, culture fit for ops-minded teams. Ask about their approach to toil reduction, what excites them about cloud infrastructure, and how they view the DevOps/SRE role.',
    interviewerTone: 'Pragmatic and systems-oriented. Show interest in their operational philosophy.',
    scoringEmphasis: 'Evaluate passion for automation, communication about reliability principles, culture fit for on-call and incident-driven teams, and understanding of DevOps culture.',
    antiPatterns: 'Do NOT ask about specific Terraform modules, Kubernetes manifests, or cloud service details. Screening is about operational mindset, automation philosophy, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect interest in automation and infrastructure, basic understanding of CI/CD concepts, and enthusiasm for solving operational problems. Look for homelab or side projects.',
      '3-6': 'Expect clear articulation of DevOps principles, experience with on-call rotations, and understanding of the tension between velocity and reliability.',
      '7+': 'Expect a strategic view of platform engineering: building internal developer platforms, SRE culture, error budget philosophy, and scaling operational practices across organizations.',
    },
    domainRedFlags: [
      'No interest in automation — prefers manual operational processes',
      'Cannot describe any experience with CI/CD pipelines or infrastructure tooling',
      'Views DevOps as purely a tools role with no cultural or process dimension',
    ],
  },
  'devops:behavioral': {
    questionStrategy: 'Explore scenarios around managing major incidents, making decisions during outages, driving post-mortem culture, handling on-call burnout, advocating for reliability investment, and navigating tension between dev velocity and operational stability.',
    interviewerTone: 'Experienced ops leader who understands the unique pressures of infrastructure work — on-call stress, incident fatigue, and the challenge of invisible work.',
    scoringEmphasis: 'Evaluate incident leadership, blameless culture advocacy, ability to influence engineering practices, resilience under operational pressure, and growth from incidents.',
    antiPatterns: 'Do NOT ask to whiteboard infrastructure diagrams or quiz on cloud service specifics. Behavioral for DevOps focuses on incident leadership, blameless culture, and influencing reliability investment.',
    experienceCalibration: {
      '0-2': 'Expect stories about first on-call experiences, learning from incidents they observed, and early efforts to automate manual processes.',
      '3-6': 'Expect incident command stories, post-mortem leadership, navigating on-call burnout, and advocating for reliability investment against feature pressure.',
      '7+': 'Expect organizational impact: establishing blameless post-mortem culture, building SRE teams, defining error budget policies, and transforming operational practices across engineering.',
    },
    domainRedFlags: [
      'Describes incidents with blame rather than systemic analysis',
      'No examples of improving processes after failures',
      'Cannot articulate how they handle the stress of on-call or production pressure',
    ],
  },
  'devops:technical': {
    questionStrategy: 'Deep-dive into CI/CD pipeline design, infrastructure-as-code (Terraform, Pulumi), container orchestration (Kubernetes), cloud architecture (AWS/GCP/Azure), monitoring and observability (Prometheus, Grafana, DataDog), SLO/SLI/SLA design, and chaos engineering.',
    interviewerTone: 'Collaborative infrastructure architect. Discuss design philosophy and tradeoffs, not just tool proficiency.',
    technicalTranslation: 'Technical means: infrastructure architecture, CI/CD design, container orchestration, cloud platform expertise, observability systems, and reliability engineering practices.',
    scoringEmphasis: 'Evaluate infrastructure design thinking, understanding of reliability principles (SLOs, error budgets), ability to reason about cost vs. reliability tradeoffs, and depth of cloud platform experience.',
    antiPatterns: 'Do NOT ask application-level coding questions or product feature design. Technical for DevOps means infrastructure architecture, CI/CD pipelines, observability, and reliability engineering.',
    experienceCalibration: {
      '0-2': 'Expect familiarity with one cloud provider, basic Terraform/IaC usage, Docker fundamentals, and understanding of CI/CD pipeline concepts.',
      '3-6': 'Expect production infrastructure experience: Kubernetes operations, multi-environment CI/CD, monitoring stack design, SLO definition, and cost optimization.',
      '7+': 'Expect platform architecture: multi-region infrastructure design, internal developer platform strategy, FinOps practices, chaos engineering programs, and SRE organizational design.',
    },
    domainRedFlags: [
      'Cannot explain the difference between SLOs, SLIs, and SLAs',
      'Only knows one cloud provider with no transferable infrastructure principles',
      'No experience with infrastructure-as-code — relies on console/manual provisioning',
      'Cannot discuss monitoring beyond basic uptime checks',
    ],
  },
  'devops:case-study': {
    questionStrategy: 'Present infrastructure scenarios: design a zero-downtime deployment pipeline, architect a multi-region disaster recovery system, plan a cloud migration for a legacy on-premises platform, or design an incident response system.',
    interviewerTone: 'Infrastructure architect who presents realistic constraints around budget, team size, legacy systems, and compliance requirements.',
    technicalTranslation: 'Case study means: infrastructure architecture design, migration planning, reliability system design, and operational process architecture.',
    scoringEmphasis: 'Evaluate structured approach to infrastructure design, cost-awareness, consideration of failure modes, operational runbook thinking, and ability to phase complex migrations.',
    antiPatterns: 'Do NOT present application architecture problems without infrastructure constraints. Case studies for DevOps should include budget, compliance requirements, team size, and existing infrastructure as constraints.',
    experienceCalibration: {
      '0-2': 'Expect basic infrastructure planning: single-region deployment, simple CI/CD pipeline design, and basic disaster recovery awareness. Guide through constraints.',
      '3-6': 'Expect multi-environment design with cost considerations, phased migration plans, monitoring strategy, and awareness of compliance and security requirements.',
      '7+': 'Expect comprehensive platform thinking: multi-region active-active design, FinOps modeling, organizational change management for migrations, and detailed rollback strategies.',
    },
    domainRedFlags: [
      'No consideration of cost implications in infrastructure design decisions',
      'Cannot phase a migration — proposes big-bang cutover for complex systems',
      'Ignores compliance, security, or regulatory constraints entirely',
    ],
  },
}
