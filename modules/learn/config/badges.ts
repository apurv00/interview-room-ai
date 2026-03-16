import { BADGE_XP } from './xpTable'

export type BadgeCategory = 'milestone' | 'streak' | 'score' | 'exploration' | 'social'
export type BadgeRarity = 'common' | 'rare' | 'epic' | 'legendary'

export type BadgeTriggerType =
  | 'interview_complete'
  | 'drill_complete'
  | 'streak_update'
  | 'daily_challenge'
  | 'share'
  | 'domain_practice'

export interface BadgeCheckContext {
  userId: string
  triggerType: BadgeTriggerType
  // Contextual data from trigger
  interviewCount?: number
  currentStreak?: number
  score?: number
  previousScore?: number
  domainCount?: number
  depthCount?: number
  dailyChallengeCount?: number
}

export interface BadgeDef {
  id: string
  name: string
  description: string
  icon: string
  category: BadgeCategory
  xpReward: number
  rarity: BadgeRarity
  triggerTypes: BadgeTriggerType[]
  check: (ctx: BadgeCheckContext) => boolean
}

export const BADGE_DEFINITIONS: BadgeDef[] = [
  // ─── Milestone ─────────────────────────────────────────────────────────────
  {
    id: 'first_interview',
    name: 'First Steps',
    description: 'Complete your first interview',
    icon: '🎯',
    category: 'milestone',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.interviewCount ?? 0) >= 1,
  },
  {
    id: 'interviews_5',
    name: 'Getting Warmed Up',
    description: 'Complete 5 interviews',
    icon: '🔥',
    category: 'milestone',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.interviewCount ?? 0) >= 5,
  },
  {
    id: 'interviews_25',
    name: 'Dedicated Practicer',
    description: 'Complete 25 interviews',
    icon: '💪',
    category: 'milestone',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.interviewCount ?? 0) >= 25,
  },
  {
    id: 'interviews_100',
    name: 'Interview Centurion',
    description: 'Complete 100 interviews',
    icon: '🏆',
    category: 'milestone',
    xpReward: BADGE_XP.legendary,
    rarity: 'legendary',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.interviewCount ?? 0) >= 100,
  },

  // ─── Streak ────────────────────────────────────────────────────────────────
  {
    id: 'streak_3',
    name: '3-Day Streak',
    description: 'Practice 3 days in a row',
    icon: '⚡',
    category: 'streak',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['streak_update'],
    check: (ctx) => (ctx.currentStreak ?? 0) >= 3,
  },
  {
    id: 'streak_7',
    name: 'Week Warrior',
    description: 'Practice 7 days in a row',
    icon: '🗓️',
    category: 'streak',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['streak_update'],
    check: (ctx) => (ctx.currentStreak ?? 0) >= 7,
  },
  {
    id: 'streak_14',
    name: 'Two-Week Titan',
    description: 'Practice 14 days in a row',
    icon: '🌟',
    category: 'streak',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['streak_update'],
    check: (ctx) => (ctx.currentStreak ?? 0) >= 14,
  },
  {
    id: 'streak_30',
    name: 'Month Master',
    description: 'Practice 30 days in a row',
    icon: '👑',
    category: 'streak',
    xpReward: BADGE_XP.epic,
    rarity: 'epic',
    triggerTypes: ['streak_update'],
    check: (ctx) => (ctx.currentStreak ?? 0) >= 30,
  },
  {
    id: 'streak_100',
    name: 'Unstoppable',
    description: 'Practice 100 days in a row',
    icon: '💎',
    category: 'streak',
    xpReward: BADGE_XP.legendary,
    rarity: 'legendary',
    triggerTypes: ['streak_update'],
    check: (ctx) => (ctx.currentStreak ?? 0) >= 100,
  },

  // ─── Score ─────────────────────────────────────────────────────────────────
  {
    id: 'score_70',
    name: 'Solid Performer',
    description: 'Score 70+ on an interview',
    icon: '📈',
    category: 'score',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.score ?? 0) >= 70,
  },
  {
    id: 'score_80',
    name: 'Strong Candidate',
    description: 'Score 80+ on an interview',
    icon: '🎖️',
    category: 'score',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.score ?? 0) >= 80,
  },
  {
    id: 'score_90',
    name: 'Outstanding',
    description: 'Score 90+ on an interview',
    icon: '🌠',
    category: 'score',
    xpReward: BADGE_XP.epic,
    rarity: 'epic',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.score ?? 0) >= 90,
  },
  {
    id: 'score_100',
    name: 'Perfect Score',
    description: 'Achieve a perfect 100 score',
    icon: '💯',
    category: 'score',
    xpReward: BADGE_XP.legendary,
    rarity: 'legendary',
    triggerTypes: ['interview_complete'],
    check: (ctx) => (ctx.score ?? 0) >= 100,
  },
  {
    id: 'comeback',
    name: 'Comeback Kid',
    description: 'Improve your score by 20+ points between sessions',
    icon: '🚀',
    category: 'score',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['interview_complete'],
    check: (ctx) => {
      if (ctx.score == null || ctx.previousScore == null) return false
      return ctx.score - ctx.previousScore >= 20
    },
  },

  // ─── Exploration ───────────────────────────────────────────────────────────
  {
    id: 'explorer_3_domains',
    name: 'Domain Explorer',
    description: 'Practice in 3 different interview domains',
    icon: '🧭',
    category: 'exploration',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['domain_practice'],
    check: (ctx) => (ctx.domainCount ?? 0) >= 3,
  },
  {
    id: 'depth_explorer',
    name: 'Depth Diver',
    description: 'Try all interview depth levels',
    icon: '🔬',
    category: 'exploration',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['domain_practice'],
    check: (ctx) => (ctx.depthCount ?? 0) >= 6,
  },
  {
    id: 'daily_challenger',
    name: 'Daily Challenger',
    description: 'Complete your first daily challenge',
    icon: '📝',
    category: 'exploration',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['daily_challenge'],
    check: (ctx) => (ctx.dailyChallengeCount ?? 0) >= 1,
  },
  {
    id: 'daily_challenge_10',
    name: 'Challenge Veteran',
    description: 'Complete 10 daily challenges',
    icon: '🎲',
    category: 'exploration',
    xpReward: BADGE_XP.rare,
    rarity: 'rare',
    triggerTypes: ['daily_challenge'],
    check: (ctx) => (ctx.dailyChallengeCount ?? 0) >= 10,
  },

  // ─── Social ────────────────────────────────────────────────────────────────
  {
    id: 'shared_scorecard',
    name: 'Show & Tell',
    description: 'Share a scorecard with others',
    icon: '📤',
    category: 'social',
    xpReward: BADGE_XP.common,
    rarity: 'common',
    triggerTypes: ['share'],
    check: () => true, // Triggered by share action itself
  },
]

export function getBadgesByTrigger(triggerType: BadgeTriggerType): BadgeDef[] {
  return BADGE_DEFINITIONS.filter(b => b.triggerTypes.includes(triggerType))
}

export function getBadgeById(badgeId: string): BadgeDef | undefined {
  return BADGE_DEFINITIONS.find(b => b.id === badgeId)
}
