import type { DomainDepthOverride } from './types'

export const pmOverrides: Record<string, DomainDepthOverride> = {
  'pm:screening': {
    questionStrategy: 'Probe motivation for product management, product sense, and culture fit. Ask about what kind of products excite them, how they think about user problems, their approach to prioritization, and why they chose PM over engineering or design.',
    interviewerTone: 'Warm and product-curious. Show genuine interest in their product thinking even during a screening.',
    scoringEmphasis: 'Evaluate product passion, communication clarity, user-centric thinking, culture fit, and ability to articulate their PM philosophy.',
    sampleOpeners: [
      'What excites you most about product management?',
      'Tell me about a product you use daily — what would you improve about it?',
    ],
  },
  'pm:behavioral': {
    questionStrategy: 'Explore scenarios around stakeholder conflicts (engineering vs. design vs. business), making hard prioritization calls, shipping under constraints, handling product failures, influencing without authority, and managing up to executive stakeholders.',
    interviewerTone: 'Experienced product leader interested in decision-making under uncertainty. Dig into the "why" behind prioritization decisions and stakeholder management.',
    scoringEmphasis: 'Evaluate stakeholder management maturity, decision-making framework, ability to handle ambiguity, self-awareness about product failures, and cross-functional leadership.',
    sampleOpeners: [
      'Tell me about a time engineering and design completely disagreed on a product direction. How did you navigate it?',
      'Describe a feature you decided to kill after significant investment. What was the process?',
    ],
  },
  'pm:technical': {
    questionStrategy: 'Deep-dive into product metrics and estimation, data-driven decision making, technical tradeoff evaluation, experimentation frameworks, product analytics, and understanding of system constraints that affect product decisions.',
    interviewerTone: 'Analytical product leader who values data rigor. Test their ability to think quantitatively about product decisions.',
    technicalTranslation: 'Technical means: product metrics (DAU, retention, conversion funnels), estimation and sizing, experimentation design, analytics frameworks, and ability to understand engineering constraints.',
    scoringEmphasis: 'Evaluate metrics literacy, estimation reasoning, ability to design experiments, understanding of technical constraints on product decisions, and data-driven thinking.',
    sampleOpeners: [
      'How would you measure the success of a new onboarding flow? Walk me through the metrics framework.',
      'Estimate the number of rides Uber completes per day in New York City. Show your reasoning.',
    ],
  },
  'pm:case-study': {
    questionStrategy: 'Present product strategy scenarios: launch a new product in an adjacent market, design a feature for a specific user segment, create a go-to-market strategy, evaluate a potential acquisition, or prioritize a roadmap with competing stakeholder demands.',
    interviewerTone: 'Product strategy interviewer who provides market context and constraints. Let the candidate structure their approach while probing assumptions.',
    technicalTranslation: 'Case study means: product strategy and design exercises involving market analysis, user segmentation, prioritization frameworks, and go-to-market planning.',
    scoringEmphasis: 'Evaluate structured thinking, user-centric framing, market awareness, ability to make and defend prioritization decisions, and quality of go-to-market reasoning.',
    sampleOpeners: [
      'You are the PM for Spotify. Design a feature to increase podcast engagement among music-only users.',
      'Your CEO wants to expand into a new market segment. How would you evaluate and plan the launch?',
    ],
  },
}
