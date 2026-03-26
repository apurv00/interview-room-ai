import type { DomainDepthOverride } from './types'

export const marketingOverrides: Record<string, DomainDepthOverride> = {
  'marketing:screening': {
    questionStrategy: 'Probe motivation for marketing, creative vs. analytical orientation, campaign experience highlights, and culture fit. Ask about their marketing philosophy, favorite campaigns they have run, and what type of marketing excites them most.',
    interviewerTone: 'Energetic and brand-aware. Show interest in both their creative instincts and analytical capabilities.',
    scoringEmphasis: 'Evaluate marketing passion, communication style, balance of creativity and data-orientation, culture fit, and ability to articulate marketing strategy.',
    antiPatterns: 'Do NOT deep-dive into martech tools or analytics platforms. Screening focuses on motivation, marketing philosophy, and culture fit.',
    experienceCalibration: {
      '0-2': 'Expect enthusiasm for marketing, 1-2 campaign examples (even academic or personal projects), and a sense of whether they lean creative or analytical. Probe curiosity and learning mindset.',
      '3-6': 'Expect a clear marketing identity (brand, growth, content, etc.), concrete campaign results, and a thoughtful marketing philosophy. Probe how their approach has evolved with experience.',
      '7+': 'Expect a strategic marketing leadership perspective, views on building marketing teams, and industry trend awareness. Probe vision for marketing organization and cross-functional influence.',
    },
    domainRedFlags: [
      'Cannot name a campaign they have worked on or articulate what made it effective',
      'Shows no awareness of the balance between brand and performance marketing',
      'Describes marketing purely as execution without strategic thinking',
    ],
  },
  'marketing:behavioral': {
    questionStrategy: 'Explore scenarios around managing campaign failures, navigating brand-vs-performance tension, handling tight launch deadlines, influencing product teams on positioning, and adapting strategy when market conditions shift suddenly.',
    interviewerTone: 'Marketing leader who understands the pressure of campaigns and brand reputation. Interested in adaptability and strategic thinking under constraints.',
    scoringEmphasis: 'Evaluate adaptability, creative problem-solving under constraints, cross-functional influence, ability to learn from campaign failures, and strategic communication.',
    antiPatterns: 'Do NOT ask about specific martech stack proficiency or analytics methodology. Behavioral for marketing means campaign adaptability, creative collaboration, and strategic pivots under pressure.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 examples of campaign execution, basic adaptability when plans changed, and willingness to learn from missteps. Probe resilience and creative problem-solving instincts.',
      '3-6': 'Expect strong examples of managing campaign pivots, navigating brand-performance tensions, and influencing cross-functional teams. Probe strategic thinking during crisis moments.',
      '7+': 'Expect sophisticated examples of leading through market shifts, managing brand reputation crises, and building marketing culture. Probe leadership during organizational or market disruption.',
    },
    domainRedFlags: [
      'Blames external factors (agency, budget, market) for campaign failures without self-reflection',
      'Cannot describe specific campaign metrics or how they measured success',
      'Shows no adaptability — insists original plans were always correct',
      'Takes sole credit for team campaign outcomes',
    ],
  },
  'marketing:technical': {
    questionStrategy: 'Deep-dive into marketing analytics (attribution modeling, funnel analysis, LTV/CAC), martech stack (CRM, CDP, marketing automation), SEO/SEM strategy, content strategy, growth loops, and experimentation in marketing.',
    interviewerTone: 'Data-driven marketing leader who values analytical rigor alongside creative strategy.',
    technicalTranslation: 'Technical means: marketing analytics and attribution, martech platforms, SEO/SEM methodology, growth modeling, funnel optimization, and experimentation frameworks.',
    scoringEmphasis: 'Evaluate analytics sophistication, martech proficiency, understanding of attribution challenges, ability to connect marketing metrics to business outcomes, and growth strategy thinking.',
    antiPatterns: 'Do NOT ask coding or data engineering questions. Technical for marketing means attribution modeling, funnel analytics, martech platforms, SEO/SEM strategy, and growth experimentation.',
    experienceCalibration: {
      '0-2': 'Expect basic understanding of marketing funnel metrics, familiarity with 1-2 martech tools, and awareness of SEO/SEM fundamentals. Probe analytical thinking and willingness to go deeper.',
      '3-6': 'Expect proficiency in attribution modeling, hands-on martech stack experience, and ability to design marketing experiments. Probe practical examples of connecting marketing metrics to revenue.',
      '7+': 'Expect mastery of multi-touch attribution, sophisticated growth modeling, and strategic martech architecture decisions. Probe ability to build analytics-driven marketing organizations.',
    },
    domainRedFlags: [
      'Cannot explain basic marketing funnel metrics (CAC, LTV, conversion rates)',
      'Relies entirely on vanity metrics (impressions, likes) without connecting to business outcomes',
      'No awareness of attribution challenges in multi-channel marketing',
    ],
  },
  'marketing:case-study': {
    questionStrategy: 'Present marketing strategy scenarios: launch a product in a crowded market, design a go-to-market plan for a new segment, create a brand repositioning strategy, develop a content marketing engine, or plan a competitive response campaign.',
    interviewerTone: 'CMO-level interviewer who provides market context and budget constraints. Let the candidate structure the strategy while probing channel selection and measurement.',
    technicalTranslation: 'Case study means: marketing strategy exercises involving market analysis, channel strategy, budget allocation, messaging development, and measurement planning.',
    scoringEmphasis: 'Evaluate strategic marketing thinking, channel selection rationale, budget allocation logic, measurement framework, and ability to connect marketing activities to revenue.',
    antiPatterns: 'Do NOT present cases without budget or resource constraints. Marketing case studies must involve channel tradeoffs, budget allocation, and measurable outcomes.',
    experienceCalibration: {
      '0-2': 'Expect a basic marketing plan structure (audience, channels, messaging), reasonable channel selection, and awareness of measurement. Probe creative thinking and logical channel rationale.',
      '3-6': 'Expect a well-structured GTM plan with budget allocation, channel mix rationale, and a measurement framework. Probe ability to defend channel tradeoffs and handle budget constraints.',
      '7+': 'Expect sophisticated marketing strategy with competitive positioning, multi-phase rollout, and integrated measurement. Probe strategic resource allocation, brand-performance balance, and long-term vision.',
    },
    domainRedFlags: [
      'Cannot structure a coherent marketing plan with clear audience and channel strategy',
      'Ignores budget constraints and proposes unrealistic resource allocation',
      'No measurement framework — cannot articulate how they would know if the strategy worked',
      'Focuses on a single channel without considering an integrated approach',
    ],
  },
}
