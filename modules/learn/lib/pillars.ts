// ─── Topical Pillar Hubs ────────────────────────────────────────────────────
// Hub-and-spoke SEO architecture. Each Pillar is a standalone static route at
// /learn/guides/{pillar-slug} that consolidates topical authority and links to
// its constituent "spoke" guides (stored in resources.ts).

export interface PillarSpoke {
  /** Existing Resource slug in modules/learn/lib/resources.ts */
  slug: string
  /** Pillar-specific blurb shown on the hub page (overrides generic description for context). */
  blurb: string
}

export interface PillarSection {
  heading: string
  body: string
}

export interface PillarFAQ {
  q: string
  a: string
}

export interface Pillar {
  slug: 'behavioral-interviews' | 'company-interviews' | 'interview-types'
  title: string
  metaTitle: string
  metaDescription: string
  keywords: string[]
  intro: string
  sections: PillarSection[]
  spokes: PillarSpoke[]
  faq: PillarFAQ[]
}

// Populated in pillars/behavioral.ts, pillars/company.ts, pillars/types.ts.
// Declared here as an empty array so early edits to consumer files resolve.
export const PILLARS: Pillar[] = [
  {
    slug: 'behavioral-interviews',
    title: 'Behavioral Interview Mastery',
    metaTitle: 'Behavioral Interview Mastery — STAR Method, Stories & Practice',
    metaDescription: 'The complete hub for behavioral interview prep: STAR method, common behavioral questions, body language, interview frameworks, and worked example answers.',
    keywords: [
      'behavioral interview',
      'behavioral interview questions',
      'STAR method',
      'behavioral interview prep',
      'behavioral interview examples',
      'common interview questions',
    ],
    intro:
      'Behavioral interviews are the single most widely used interview format in technology, consulting, finance, and product — and the one most candidates prepare for the least systematically. This hub brings together everything you need to consistently score at the top of the rubric: the STAR method with a full worked example, the most common behavioral questions with model answers, body-language signals interviewers are explicitly trained to watch for, and alternative frameworks (SPAR, CAR, PPF) for when STAR is not the right shape. Use it as a sequenced prep path or jump straight to the spoke that matches your weakest area.',
    sections: [
      {
        heading: 'Why Behavioral Rounds Decide Most Offers',
        body: 'Hiring committees at Google, Amazon, Meta, McKinsey, BCG, Goldman, and most well-run startups weight behavioral performance heavily — often 40 to 60 percent of the final decision for non-junior roles. The reason is simple: technical skill is easier to verify than judgment, ownership, and communication, and those three qualities are exactly what behavioral questions test. A candidate who is technically strong but behaviorally vague almost always loses to a candidate who is technically adequate but tells clean, quantified stories. If you are getting final-round rejections, this is usually the reason.',
      },
      {
        heading: 'The STAR-First Prep Path',
        body: 'If you only have a week, spend it on STAR. Read the STAR method guide end-to-end, build 8 to 10 versatile stories from your last two years of work, and practice each one out loud on a 2-minute timer until you can finish without rushing. Then run through the common behavioral questions guide and map each question to one of your stories. Do not memorize word-for-word — memorize the shape. On the day of the interview, your goal is to land the framework cleanly, not to deliver a rehearsed speech.',
      },
      {
        heading: 'Body Language and Delivery',
        body: 'Behavioral content and behavioral delivery are scored separately. You can tell a technically perfect STAR story and still drop a full point for flat eye contact, nervous hand gestures, or a speaking pace that hovers above 180 words per minute. The body language guide covers the signals interviewers are explicitly trained to notice, and the video interview tips guide covers the camera-specific adjustments that most candidates miss. If you are practicing on video, re-watch your recordings with sound off once and with sound only once — you will catch different problems each pass.',
      },
    ],
    spokes: [
      { slug: 'star-method-guide', blurb: 'The gold-standard framework for behavioral answers. Includes a full worked example, time budget, and common mistakes.' },
      { slug: 'behavioral-questions', blurb: 'The 12 most common behavioral questions with model answers, scoring rubrics, and prep templates.' },
      { slug: 'common-interview-questions', blurb: 'Classic openers and culture-fit questions every interviewer asks — and how to answer them without sounding rehearsed.' },
      { slug: 'body-language-guide', blurb: 'Non-verbal signals interviewers score against: posture, eye contact, hand gestures, and confidence cues.' },
      { slug: 'interview-frameworks', blurb: 'Alternative answer structures (SPAR, CAR, Present-Past-Future) for when STAR is not the right shape.' },
    ],
    faq: [
      { q: 'How long should I prepare for a behavioral interview?', a: 'Two to four weeks of focused practice is enough for most candidates. Spend the first week building 8 to 10 STAR stories, the second week practicing them out loud on a timer, and the remaining time running mock interviews and tightening the weakest stories.' },
      { q: 'Do I need to memorize answers word-for-word?', a: 'No — memorized answers sound robotic and collapse the moment a follow-up question forces you off script. Memorize the shape of each story (situation, task, action, result) and trust the framework to carry you through.' },
      { q: 'What if my weakest behavioral area is quantifying results?', a: 'You do not need exact numbers. Calibrated estimates ("approximately 30 percent", "roughly half") consistently score higher than vague outcomes ("things went well"). Interviewers respect self-aware estimates more than perfect amnesia.' },
      { q: 'How is a behavioral interview different from a culture-fit interview?', a: 'Behavioral interviews ask about past actions ("tell me about a time"); culture-fit interviews ask about values and working style ("how do you handle disagreements with your manager"). The STAR method is the right tool for behavioral questions; culture-fit questions usually need a shorter, more direct answer rooted in an example.' },
    ],
  },
  {
    slug: 'company-interviews',
    title: 'Company Interview Guides',
    metaTitle: 'Company Interview Guides — Google, Amazon, Meta, McKinsey & More',
    metaDescription: 'Deep-dive interview guides for the top tech and consulting employers: Google, Amazon, Meta, Apple, Microsoft, Netflix, Stripe, Salesforce, McKinsey, BCG, Goldman Sachs, and JPMorgan.',
    keywords: [
      'company interview guides',
      'google interview',
      'amazon leadership principles',
      'meta interview',
      'mckinsey case interview',
      'goldman sachs super day',
      'tech company interview prep',
    ],
    intro:
      'Every top employer has an interview process with its own quirks, scoring rubric, and unwritten rules. Prepping generically and hoping for the best is a losing strategy — the candidates who consistently convert final rounds are the ones who show up knowing exactly what format they will face, which attributes the hiring committee is scoring, and what the "good answer" shape looks like for that specific company. This hub collects our deep-dive guides for the 12 employers that collectively hire the largest share of our users. Each guide is written for candidates preparing over 2 to 8 weeks and includes the full hiring loop, the scoring attributes, and a focused prep plan.',
    sections: [
      {
        heading: 'Tech: Google, Amazon, Meta, Apple, Microsoft, Netflix',
        body: 'The six largest tech employers all run structured behavioral loops, but they optimize for very different things. Google scores against "Googleyness" and four general-cognitive-ability attributes. Amazon scores against 16 Leadership Principles with an external Bar Raiser in the loop. Meta weights impact and speed. Apple guards its process but rewards craft and product passion. Microsoft centers growth mindset. Netflix interviews against "Freedom and Responsibility" with an unusually high bar for independent judgment. Using the wrong framework for the wrong company is the most common avoidable mistake.',
      },
      {
        heading: 'Fintech & Developer Platforms: Stripe and Salesforce',
        body: 'Stripe and Salesforce both run behavioral loops, but their cultures reward different signals. Stripe looks for craft, systems thinking, and clear written communication — many rounds include a writing exercise or a question about trade-off analysis. Salesforce centers the "Ohana" culture and evaluates trust, customer success orientation, and values-driven leadership. For either company, generic STAR stories fall flat; you need stories that explicitly surface the attribute they care about.',
      },
      {
        heading: 'Consulting & Finance: McKinsey, BCG, Goldman, JPMorgan',
        body: 'Consulting and finance interviews are a different animal from tech interviews. McKinsey and BCG run case interviews with hypothesis-driven structure, the McKinsey Solve game, and a Personal Experience Interview (PEI) scored against three distinct dimensions. Goldman Sachs runs a Super Day with back-to-back rounds covering technical finance, market awareness, and behavioral preparation. JPMorgan emphasizes risk awareness, analytical rigor, and client relationship skills. Each of these guides walks you through the format, the scoring lens, and a 4 to 6 week prep plan.',
      },
    ],
    spokes: [
      { slug: 'how-to-interview-at-google', blurb: 'Full hiring loop, the four scoring attributes, "Googleyness" decoded, and a 4-week prep plan.' },
      { slug: 'amazon-leadership-principles-guide', blurb: 'The 16 Leadership Principles in plain English, the Bar Raiser explained, and a story-mapping system for the 30+ STAR stories Amazon expects.' },
      { slug: 'how-to-interview-at-meta', blurb: 'Impact, speed, and moving fast — how Meta scores behavioral rounds and what the technical loop looks like.' },
      { slug: 'how-to-interview-at-apple', blurb: 'Navigate Apple\'s secretive process with tips on craft, product passion, and attention to detail.' },
      { slug: 'how-to-interview-at-microsoft', blurb: 'Growth mindset, inclusive leadership, and customer empathy — the three pillars of the Microsoft rubric.' },
      { slug: 'how-to-interview-at-netflix', blurb: 'Freedom and Responsibility explained: how Netflix tests independent judgment, candor, and high-performance standards.' },
      { slug: 'how-to-interview-at-stripe', blurb: 'Craft, systems thinking, and clear written communication — the three Stripe-specific signals to surface.' },
      { slug: 'how-to-interview-at-salesforce', blurb: 'Trust, customer success, and the Ohana culture — how Salesforce scores values-driven leadership.' },
      { slug: 'mckinsey-interview-guide', blurb: 'Case interview, PEI, McKinsey Solve game, and a focused 6-week prep plan.' },
      { slug: 'bcg-interview-guide', blurb: 'Creative case approaches, hypothesis-driven thinking, and BCG-specific behavioral questions.' },
      { slug: 'goldman-sachs-interview-guide', blurb: 'Super Day format, technical finance questions, market awareness, and behavioral prep.' },
      { slug: 'jpmorgan-interview-guide', blurb: 'Risk awareness, analytical rigor, and client relationship skills across investment banking, asset management, and technology divisions.' },
    ],
    faq: [
      { q: 'How far in advance should I start prepping for a specific company?', a: 'Plan for 4 weeks at a minimum for tech companies and 6 to 8 weeks for consulting firms. If you are already strong on behavioral and technical fundamentals, 2 weeks of company-specific prep is enough.' },
      { q: 'Do I need different stories for different companies?', a: 'You do not need different stories, but you do need to reframe the same stories to surface different attributes. An Amazon answer and a Google answer to the same question should emphasize different actions even if the underlying project is the same.' },
      { q: 'What if the company I am interviewing at is not in this list?', a: 'Start with the closest cultural match — most tech companies run loops that look like one of the big six, and most finance and consulting firms run variants of the McKinsey or Goldman format. Apply the relevant rubric as a starting point.' },
    ],
  },
  {
    slug: 'interview-types',
    title: 'Interview Types & Formats',
    metaTitle: 'Interview Types & Formats — Phone, Video, Technical & More',
    metaDescription: 'Master every interview format: phone screens, video interviews, technical rounds, mock interviews, and second-round interviews with expert tips and prep plans.',
    keywords: [
      'interview types',
      'phone interview',
      'video interview',
      'technical interview',
      'mock interview',
      'second interview',
      'interview format',
    ],
    intro:
      'Interview format shapes performance as much as interview content. A clean STAR answer delivered on the phone reads differently than the same answer delivered over video or in person — and a technical deep-dive on Zoom has completely different failure modes than the same conversation at a whiteboard. This hub collects our format-specific guides so you can calibrate for the exact round you are facing. Start with the format and add the relevant behavioral and company prep on top.',
    sections: [
      {
        heading: 'Phone and Video Screens',
        body: 'The initial phone or video screen is the single highest-leverage round in most hiring loops — not because it is the hardest, but because it is the one most candidates underprepare for. A 30-minute recruiter call decides whether you get into the on-site loop at all. The phone interview guide covers voice-only adjustments (you cannot rely on body language) and the video interview guide covers camera setup, framing, and the lighting mistakes that quietly tank otherwise strong candidates on Zoom and Teams.',
      },
      {
        heading: 'Technical Rounds',
        body: 'Technical interviews assess domain expertise through problem-solving, system design, and knowledge-based questions. The shape varies heavily by domain — software engineers face coding problems and system design, data scientists face SQL and case studies, DevOps engineers face infrastructure scenarios — but the core principles are the same: think aloud, structure your approach, and communicate clearly. The technical interview questions guide breaks down the format for each major domain and explains the "think aloud" pattern interviewers explicitly listen for.',
      },
      {
        heading: 'Mock Interviews and Second Rounds',
        body: 'Mock interviews are the cheapest, highest-return prep tool available — and the one candidates most often skip because it feels uncomfortable. Even a single 30-minute mock with feedback tends to add more to a candidate\'s final score than 10 hours of solo study. Second-round interviews are a different shape entirely: longer, more detailed, and often with a panel or hiring manager who will probe deeper into your stories and test cultural fit against the specific team.',
      },
    ],
    spokes: [
      { slug: 'phone-interview-tips', blurb: 'Voice-only delivery, pacing, and the recruiter-screen playbook most candidates underprepare for.' },
      { slug: 'video-interview-tips', blurb: 'Camera setup, framing, lighting, and the Zoom-specific adjustments that separate strong candidates from the rest.' },
      { slug: 'technical-interview-questions', blurb: 'Domain-specific prep for software engineering, data science, DevOps, and system design rounds.' },
      { slug: 'mock-interview-guide', blurb: 'How to run mock interviews effectively, what feedback to ask for, and why they are the highest-ROI prep tool.' },
      { slug: 'second-interview-questions', blurb: 'What changes in the second round: deeper stories, panel dynamics, culture fit, and the 90-day-plan question.' },
    ],
    faq: [
      { q: 'Should I prepare differently for phone vs video interviews?', a: 'Yes. Phone interviews are voice-only so pacing, tone, and clear structure matter more; video interviews add framing, eye contact, and camera angle to the signal set. The two formats are scored against overlapping but distinct rubrics.' },
      { q: 'How many mock interviews should I do before a real one?', a: 'Two to four is the sweet spot for most candidates. One is enough to catch your biggest weakness; two to four is enough to correct it. Beyond four, the returns diminish quickly — you are better off spending the time on targeted content prep.' },
      { q: 'Do second-round interviews use the same format as first rounds?', a: 'Usually longer and more detailed, often with multiple interviewers or a panel. Expect deeper probes into your stories, role-specific scenarios, and cultural fit questions rather than the basic behavioral openers.' },
    ],
  },
]

export function getPillarBySlug(slug: string): Pillar | undefined {
  return PILLARS.find(p => p.slug === slug)
}

export function getPillarTitle(slug: string): string {
  return getPillarBySlug(slug)?.title ?? ''
}

export function getAllPillarSlugs(): string[] {
  return PILLARS.map(p => p.slug)
}
