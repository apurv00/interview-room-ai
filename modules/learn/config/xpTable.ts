// ─── XP Amounts ──────────────────────────────────────────────────────────────
export const XP_AMOUNTS = {
  interview_complete: 50,
  drill_complete: 10,
  daily_challenge: 25,
  daily_challenge_top_quartile_bonus: 10,
  pathway_task: 15,
  streak_bonus_per_day: 5, // ×min(streakDays, 30)
  streak_bonus_cap: 30,
} as const

// ─── Badge XP Rewards ────────────────────────────────────────────────────────
export const BADGE_XP = {
  common: 10,
  rare: 25,
  epic: 50,
  legendary: 100,
} as const

// ─── Level System ────────────────────────────────────────────────────────────
// Level formula: floor(sqrt(xp / 100)) + 1
// L1=0, L2=100, L3=400, L5=1600, L10=8100

export function calculateLevel(xp: number): {
  level: number
  title: string
  xpForCurrentLevel: number
  xpForNextLevel: number
} {
  const level = Math.floor(Math.sqrt(xp / 100)) + 1
  const xpForCurrentLevel = (level - 1) ** 2 * 100
  const xpForNextLevel = level ** 2 * 100

  return {
    level,
    title: getLevelTitle(level),
    xpForCurrentLevel,
    xpForNextLevel,
  }
}

export const LEVEL_TITLES = [
  'Novice',       // 1
  'Beginner',     // 2
  'Apprentice',   // 3
  'Practitioner', // 4
  'Intermediate', // 5
  'Proficient',   // 6
  'Skilled',      // 7
  'Advanced',     // 8
  'Expert',       // 9
  'Master',       // 10
  'Grandmaster',  // 11+
] as const

export function getLevelTitle(level: number): string {
  if (level <= 0) return LEVEL_TITLES[0]
  if (level > LEVEL_TITLES.length) return LEVEL_TITLES[LEVEL_TITLES.length - 1]
  return LEVEL_TITLES[level - 1]
}
