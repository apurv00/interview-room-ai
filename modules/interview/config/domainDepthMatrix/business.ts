import type { DomainDepthOverride } from './types'

export const businessOverrides: Record<string, DomainDepthOverride> = {
  'business:screening': {
    questionStrategy: 'Probe motivation for business/strategy roles, analytical thinking, leadership potential, and culture fit. Ask about their business background, what kind of strategic problems excite them, and their career trajectory in consulting or corporate strategy.',
    interviewerTone: 'Professional and intellectually curious. Show interest in their strategic thinking even during an initial screen.',
    scoringEmphasis: 'Evaluate communication polish, structured thinking signals, leadership potential, culture fit for strategy-oriented teams, and genuine interest in business problem-solving.',
    antiPatterns: 'Do NOT present case problems or ask for framework application. Screening focuses on motivation, communication polish, and culture fit for strategy roles.',
    experienceCalibration: {
      '0-2': 'Expect clear articulation of interest in strategy, basic business acumen, and polished communication. Probe intellectual curiosity and structured thinking potential.',
      '3-6': 'Expect a defined career narrative in strategy or consulting, concrete examples of business impact, and confident communication. Probe depth of strategic thinking.',
      '7+': 'Expect executive-level presence, a track record of strategic leadership, and clear vision for their next career chapter. Probe leadership philosophy and strategic perspective.',
    },
    domainRedFlags: [
      'Cannot articulate why they are drawn to strategy or business roles',
      'Communication is unstructured and rambling without clear points',
      'Shows no awareness of current business trends or market dynamics',
    ],
  },
  'business:behavioral': {
    questionStrategy: 'Explore scenarios around influencing senior stakeholders, driving cross-functional initiatives, making decisions with incomplete data, managing ambiguous projects, and leading through organizational change.',
    interviewerTone: 'Senior business leader who values executive presence and structured communication. Interested in strategic decision-making and stakeholder influence.',
    scoringEmphasis: 'Evaluate executive communication, structured problem-solving, ability to influence without authority, comfort with ambiguity, and strategic leadership maturity.',
    antiPatterns: 'Do NOT ask for framework application or quantitative analysis. Behavioral for business/strategy means stakeholder influence, navigating ambiguity, and driving organizational decisions.',
    experienceCalibration: {
      '0-2': 'Expect 1-2 examples of working on ambiguous projects, basic stakeholder communication, and structured thinking. Probe comfort with uncertainty and learning agility.',
      '3-6': 'Expect strong examples of influencing senior leaders, driving cross-functional alignment, and making decisions with incomplete data. Probe executive communication maturity.',
      '7+': 'Expect sophisticated examples of leading organizational change, influencing C-suite strategy, and building high-performing strategy teams. Probe leadership through transformation.',
    },
    domainRedFlags: [
      'Cannot provide structured answers — responses lack clear beginning, middle, and end',
      'Avoids discussing ambiguous situations or claims all projects had clear direction',
      'Takes credit for strategic outcomes without describing their specific influence',
      'Shows no ability to influence without formal authority',
    ],
  },
  'business:technical': {
    questionStrategy: 'Deep-dive into strategy frameworks (Porter, BCG matrix, blue ocean), financial analysis (P&L, unit economics, valuation basics), market sizing and estimation, competitive analysis, and data-driven business decision-making.',
    interviewerTone: 'Strategy consultant who values rigorous analytical thinking. Test framework application and quantitative reasoning.',
    technicalTranslation: 'Technical means: strategy frameworks, financial modeling basics, market sizing, competitive analysis, unit economics, and data-driven business reasoning.',
    scoringEmphasis: 'Evaluate framework selection and application, quantitative reasoning, market analysis depth, ability to synthesize data into strategic recommendations, and financial literacy.',
    antiPatterns: 'Do NOT ask coding questions. Technical for business/strategy means frameworks (Porter, BCG), financial literacy, market sizing, and quantitative reasoning.',
    experienceCalibration: {
      '0-2': 'Expect familiarity with core frameworks (Porter, SWOT), basic market sizing ability, and fundamental financial literacy (P&L, margins). Probe structured analytical thinking.',
      '3-6': 'Expect fluent application of multiple strategy frameworks, solid market sizing with sensible assumptions, and working knowledge of unit economics and valuation. Probe practical application depth.',
      '7+': 'Expect mastery of framework selection and adaptation, sophisticated financial analysis, and ability to synthesize quantitative and qualitative insights into executive-level recommendations. Probe strategic judgment.',
    },
    domainRedFlags: [
      'Applies frameworks mechanically without adapting to the specific context',
      'Cannot perform basic market sizing or estimation with reasonable assumptions',
      'Lacks financial literacy — cannot read a P&L or explain unit economics',
    ],
  },
  'business:case-study': {
    questionStrategy: 'Present classic business strategy cases: market entry analysis, M&A evaluation, pricing strategy, turnaround scenario, competitive response strategy, or growth plan for a scaling startup.',
    interviewerTone: 'Case interviewer in the consulting tradition. Present the case, provide data when asked, and probe the candidate\'s framework and logic.',
    technicalTranslation: 'Case study means: structured business problem-solving involving market analysis, financial reasoning, strategic recommendation, and implementation planning.',
    scoringEmphasis: 'Evaluate case structuring ability, hypothesis-driven approach, quantitative analysis, quality of recommendation, and ability to handle pushback on assumptions.',
    antiPatterns: 'Do NOT use cases that lack data or quantitative elements. Business case studies must involve structured problem-solving with financial reasoning and clear recommendations.',
    experienceCalibration: {
      '0-2': 'Expect a basic structured approach (issue tree or framework), willingness to make assumptions, and a clear recommendation. Probe logical reasoning over sophistication.',
      '3-6': 'Expect hypothesis-driven case structuring, ability to request and analyze data, and a well-defended recommendation with implementation considerations. Probe analytical rigor and pushback handling.',
      '7+': 'Expect elegant case structuring, sophisticated quantitative analysis, multi-stakeholder awareness, and executive-ready recommendations with risk mitigation. Probe strategic judgment under pressure.',
    },
    domainRedFlags: [
      'Cannot structure the problem — jumps to conclusions without a framework',
      'Fails to ask clarifying questions or request relevant data',
      'Makes recommendations without quantitative support',
      'Cannot handle pushback on assumptions gracefully',
    ],
  },
}
