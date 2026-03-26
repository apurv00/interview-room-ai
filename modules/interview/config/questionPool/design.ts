import type { PoolQuestion } from './types'

export const designQuestions: Record<string, PoolQuestion[]> = {
  'design:screening': [
    { question: 'What kind of design problems are you most passionate about solving?', experience: '0-2', targetCompetency: 'motivation', followUpTheme: 'portfolio examples' },
    { question: 'Walk me through a project from your portfolio that you are most proud of.', experience: '0-2', targetCompetency: 'craft_storytelling', followUpTheme: 'process and decisions' },
    { question: 'How has your design process evolved over the years?', experience: '3-6', targetCompetency: 'professional_growth', followUpTheme: 'key turning points' },
    { question: 'What is your philosophy on the relationship between design and engineering?', experience: '3-6', targetCompetency: 'collaboration_philosophy', followUpTheme: 'practical examples' },
    { question: 'How do you think about scaling design culture across a growing organization?', experience: '7+', targetCompetency: 'leadership_vision', followUpTheme: 'hiring and processes' },
    { question: 'What does design excellence mean to you at the organizational level?', experience: '7+', targetCompetency: 'strategic_design', followUpTheme: 'measuring design impact' },
    { question: 'How do you approach learning about users you have never met?', experience: 'all', targetCompetency: 'user_empathy', followUpTheme: 'research methods' },
  ],
  'design:behavioral': [
    { question: 'Tell me about a time your design was significantly changed by stakeholder feedback.', experience: '0-2', targetCompetency: 'feedback_handling', followUpTheme: 'emotional response and growth' },
    { question: 'Describe a situation where user research contradicted what the business wanted to build.', experience: '0-2', targetCompetency: 'user_advocacy', followUpTheme: 'resolution approach' },
    { question: 'Tell me about a time you had to design for accessibility when the team resisted the effort.', experience: '3-6', targetCompetency: 'advocacy', followUpTheme: 'influence tactics' },
    { question: 'Describe how you handled design consistency challenges across multiple product teams.', experience: '3-6', targetCompetency: 'system_thinking', followUpTheme: 'governance approach' },
    { question: 'Tell me about a time you mentored a designer through a creative block or career challenge.', experience: '7+', targetCompetency: 'mentorship', followUpTheme: 'coaching philosophy' },
    { question: 'How did you build a culture of constructive design critique in your team?', experience: '7+', targetCompetency: 'culture_building', followUpTheme: 'overcoming defensiveness' },
    { question: 'Describe a design decision you made that you later realized was wrong. What happened?', experience: 'all', targetCompetency: 'self_awareness', followUpTheme: 'course correction' },
  ],
  'design:technical': [
    { question: 'How would you approach building a design system from scratch?', experience: '0-2', targetCompetency: 'design_systems', followUpTheme: 'component structure' },
    { question: 'Walk me through your process for conducting and synthesizing user research.', experience: '0-2', targetCompetency: 'research_methodology', followUpTheme: 'turning insights into design' },
    { question: 'How do you approach designing for WCAG AA accessibility compliance?', experience: '3-6', targetCompetency: 'accessibility', followUpTheme: 'testing and validation' },
    { question: 'Describe your approach to interaction design for complex workflows.', experience: '3-6', targetCompetency: 'interaction_design', followUpTheme: 'user testing methodology' },
    { question: 'How would you architect a design system that serves 10 product teams across web and mobile?', experience: '7+', targetCompetency: 'system_architecture', followUpTheme: 'governance and contribution model' },
    { question: 'What is your framework for measuring design effectiveness with quantitative data?', experience: '7+', targetCompetency: 'design_metrics', followUpTheme: 'actionable insights' },
    { question: 'How do you handle the design-to-development handoff to minimize implementation gaps?', experience: 'all', targetCompetency: 'collaboration', followUpTheme: 'tooling and process' },
  ],
  'design:case-study': [
    { question: 'Redesign the checkout flow for an e-commerce app where 60% of users abandon at payment.', experience: '0-2', targetCompetency: 'user_flow_design', followUpTheme: 'research approach' },
    { question: 'Design an onboarding experience for a complex B2B analytics tool.', experience: '0-2', targetCompetency: 'onboarding_design', followUpTheme: 'progressive disclosure' },
    { question: 'Design a mobile-first experience for a field service tool used by non-technical workers.', experience: '3-6', targetCompetency: 'contextual_design', followUpTheme: 'offline and accessibility' },
    { question: 'Create a design for a dashboard that needs to show 50 metrics without overwhelming the user.', experience: '3-6', targetCompetency: 'information_architecture', followUpTheme: 'hierarchy and personalization' },
    { question: 'Design a multi-platform design system that works across web, iOS, and Android.', experience: '7+', targetCompetency: 'cross_platform_design', followUpTheme: 'platform-specific adaptations' },
    { question: 'Redesign a legacy enterprise application for a modern audience without losing power users.', experience: '7+', targetCompetency: 'strategic_redesign', followUpTheme: 'migration path' },
    { question: 'A key feature has poor usability scores. Walk me through how you would diagnose and fix it.', experience: 'all', targetCompetency: 'ux_diagnosis', followUpTheme: 'measurement of improvement' },
  ],
}
