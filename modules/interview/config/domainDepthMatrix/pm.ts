import type { DomainDepthOverride } from './types'

export const pmOverrides: Record<string, DomainDepthOverride> = {
  'pm:screening': {
    questionStrategy: 'Probe motivation for product management, product sense, and culture fit. Ask about what kind of products excite them, how they think about user problems, their approach to prioritization, and why they chose PM over engineering or design.',
    interviewerTone: 'Warm and product-curious. Show genuine interest in their product thinking even during a screening.',
    scoringEmphasis: 'Evaluate product passion, communication clarity, user-centric thinking, culture fit, and ability to articulate their PM philosophy.',
    antiPatterns: 'Do NOT deep-dive into technical product metrics, estimation exercises, or case studies. Screening focuses on motivation, product intuition, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect genuine enthusiasm for product thinking, basic understanding of user-centric design, and clear articulation of why PM. Probe curiosity and learning agility over depth.',
      '3-6': 'Expect a clear PM philosophy, concrete examples of shipping products, and thoughtful views on prioritization. Probe how their approach has evolved.',
      '7+': 'Expect a mature product leadership perspective, vision for team building, and strategic product thinking. Probe their philosophy on scaling product organizations.',
    },
    domainRedFlags: [
      'Cannot name a product they admire or explain what makes it good',
      'Describes PM role as purely project management or feature delivery',
      'Shows no curiosity about users or dismisses user research',
    ],
  },
  'pm:behavioral': {
    questionStrategy: 'Explore scenarios around stakeholder conflicts (engineering vs. design vs. business), making hard prioritization calls, shipping under constraints, handling product failures, influencing without authority, and managing up to executive stakeholders.',
    interviewerTone: 'Experienced product leader interested in decision-making under uncertainty. Dig into the "why" behind prioritization decisions and stakeholder management.',
    scoringEmphasis: 'Evaluate stakeholder management maturity, decision-making framework, ability to handle ambiguity, self-awareness about product failures, and cross-functional leadership.',
    antiPatterns: 'Do NOT focus on technical implementation details or coding ability. Behavioral for PM means stakeholder management, prioritization decisions, and cross-functional leadership.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 solid examples of cross-functional collaboration, basic stakeholder management. Probe learning agility and product curiosity over depth.',
      '3-6': 'Expect nuanced examples of navigating stakeholder conflicts, making difficult prioritization tradeoffs, and owning product failures. Probe decision-making frameworks.',
      '7+': 'Expect sophisticated examples of influencing executive strategy, managing through organizational change, and building product culture. Probe leadership philosophy and team development.',
    },
    domainRedFlags: [
      'Blames engineering or design for product failures without acknowledging PM responsibility',
      'Cannot describe a specific prioritization framework or how they make tradeoff decisions',
      'Takes credit for team outcomes without describing how they enabled the team',
      'Avoids discussing product failures or mistakes',
    ],
  },
  'pm:technical': {
    questionStrategy: 'Deep-dive into product metrics and estimation, data-driven decision making, technical tradeoff evaluation, experimentation frameworks, product analytics, and understanding of system constraints that affect product decisions.',
    interviewerTone: 'Analytical product leader who values data rigor. Test their ability to think quantitatively about product decisions.',
    technicalTranslation: 'Technical means: product metrics (DAU, retention, conversion funnels), estimation and sizing, experimentation design, analytics frameworks, and ability to understand engineering constraints.',
    scoringEmphasis: 'Evaluate metrics literacy, estimation reasoning, ability to design experiments, understanding of technical constraints on product decisions, and data-driven thinking.',
    antiPatterns: 'Do NOT ask to write code or solve algorithms. Technical for PM means metrics, estimation, experiment design, and understanding engineering tradeoffs.',
    experienceCalibration: {
      '0-2': 'Expect basic understanding of key product metrics (DAU, retention, conversion), simple estimation approaches, and awareness of A/B testing. Probe analytical thinking process.',
      '3-6': 'Expect proficiency in metrics frameworks, experiment design with statistical awareness, and ability to evaluate engineering tradeoffs. Probe practical examples of data-driven decisions.',
      '7+': 'Expect mastery of complex metrics ecosystems, sophisticated experimentation programs, and deep understanding of system architecture implications on product. Probe strategic analytics leadership.',
    },
    domainRedFlags: [
      'Cannot define or distinguish between key product metrics like DAU, retention, and conversion',
      'Relies on gut feeling without mentioning data or experimentation',
      'Cannot walk through a basic estimation problem with structured reasoning',
    ],
  },
  'pm:case-study': {
    questionStrategy: 'Present product strategy scenarios: launch a new product in an adjacent market, design a feature for a specific user segment, create a go-to-market strategy, evaluate a potential acquisition, or prioritize a roadmap with competing stakeholder demands.',
    interviewerTone: 'Product strategy interviewer who provides market context and constraints. Let the candidate structure their approach while probing assumptions.',
    technicalTranslation: 'Case study means: product strategy and design exercises involving market analysis, user segmentation, prioritization frameworks, and go-to-market planning.',
    scoringEmphasis: 'Evaluate structured thinking, user-centric framing, market awareness, ability to make and defend prioritization decisions, and quality of go-to-market reasoning.',
    antiPatterns: 'Do NOT present pure business strategy cases without a product lens. PM case studies must center on user problems, product design decisions, and feature prioritization.',
    experienceCalibration: {
      '0-2': 'Expect a basic structured approach, user-first framing, and willingness to make prioritization calls even if reasoning is simple. Probe how they think about users and constraints.',
      '3-6': 'Expect clear frameworks for market analysis, thoughtful user segmentation, and realistic go-to-market thinking. Probe ability to handle pushback on assumptions and prioritization.',
      '7+': 'Expect sophisticated product strategy with competitive dynamics, platform thinking, and multi-phase roadmap planning. Probe vision, ecosystem effects, and strategic sequencing.',
    },
    domainRedFlags: [
      'Jumps to solutions without defining the user problem',
      'Cannot prioritize — tries to address everything simultaneously',
      'Ignores quantitative data and relies on gut feeling',
      'No mention of competitive landscape or market dynamics',
    ],
  },
}
