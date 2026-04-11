'use client'

import { useReducer, useCallback, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { calculateStrengthScore } from '../services/strengthScorer'
import type { StrengthResult } from '../services/strengthScorer'
import type { WizardSegment } from '../validators/wizardSchemas'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WizardContactInfo {
  fullName: string
  email: string
  phone?: string
  city?: string
  linkedInUrl?: string
}

export interface WizardRole {
  id: string
  company: string
  title: string
  location?: string
  startDate: string
  endDate?: string
  rawBullets: string[]
  followUpQuestions: Array<{ question: string; answer: string }>
  enhancedBullets: string[]
  bulletDecisions: Array<{ index: number; decision: 'accept' | 'reject' | 'edit'; editedText?: string }>
  finalBullets: string[]
}

export interface WizardEducation {
  id: string
  institution: string
  degree: string
  field?: string
  graduationDate?: string
  gpa?: string
  honors?: string
}

export interface WizardProject {
  id: string
  name: string
  description: string
  technologies?: string[]
  url?: string
}

export interface WizardCertification {
  name: string
  issuer: string
  date?: string
}

export interface WizardState {
  sessionId: string | null
  stage: number
  segment: WizardSegment | null
  contactInfo: WizardContactInfo
  roles: WizardRole[]
  education: WizardEducation[]
  skills: { hard: string[]; soft: string[]; technical: string[] }
  projects: WizardProject[]
  certifications: WizardCertification[]
  generatedSummary: string
  finalSummary: string
  strengthScore: number
  strengthBreakdown: { contact: number; experience: number; education: number; skills: number; extras: number }
  aiCostUsd: number
  selectedTemplate: string
  fontFamily: string
  fontSize: string
  headingSize: number
  bodySize: number
  // UI states
  isLoading: boolean
  isSaving: boolean
  isGeneratingFollowUps: boolean
  isEnhancing: boolean
  error: string | null
}

// ─── Actions ───────────────────────────────────────────────────────────────

type WizardAction =
  | { type: 'SET_SESSION_ID'; sessionId: string }
  | { type: 'SET_STAGE'; stage: number }
  | { type: 'SET_SEGMENT'; segment: WizardSegment }
  | { type: 'SET_CONTACT'; contactInfo: WizardContactInfo }
  | { type: 'SET_ROLES'; roles: WizardRole[] }
  | { type: 'UPDATE_ROLE'; roleId: string; data: Partial<WizardRole> }
  | { type: 'ADD_ROLE'; role: WizardRole }
  | { type: 'REMOVE_ROLE'; roleId: string }
  | { type: 'SET_FOLLOW_UPS'; roleId: string; questions: string[] }
  | { type: 'SET_FOLLOW_UP_ANSWER'; roleId: string; questionIndex: number; answer: string }
  | { type: 'SET_EDUCATION'; education: WizardEducation[] }
  | { type: 'SET_SKILLS'; skills: { hard: string[]; soft: string[]; technical: string[] } }
  | { type: 'SET_PROJECTS'; projects: WizardProject[] }
  | { type: 'SET_CERTIFICATIONS'; certifications: WizardCertification[] }
  | { type: 'SET_ENHANCED'; roleId: string; enhanced: string[] }
  | { type: 'SET_ALL_ENHANCED'; roles: Array<{ roleId: string; enhanced: string[] }>; summary: string }
  | { type: 'SET_BULLET_DECISION'; roleId: string; bulletIndex: number; decision: 'accept' | 'reject' | 'edit'; editedText?: string }
  | { type: 'SET_SUMMARY_DECISION'; decision: 'accept' | 'reject' | 'edit'; editedSummary?: string }
  | { type: 'SET_TEMPLATE'; template: string }
  | { type: 'SET_FONT_FAMILY'; fontFamily: string }
  | { type: 'SET_FONT_SIZE'; fontSize: string }
  | { type: 'SET_HEADING_SIZE'; headingSize: number }
  | { type: 'SET_BODY_SIZE'; bodySize: number }
  | { type: 'SET_UI_FLAG'; key: 'isLoading' | 'isSaving' | 'isGeneratingFollowUps' | 'isEnhancing'; value: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_COST'; aiCostUsd: number }
  | { type: 'LOAD_SESSION'; session: Partial<WizardState> }

// ─── Initial State ─────────────────────────────────────────────────────────

const initialState: WizardState = {
  sessionId: null,
  stage: 0,
  segment: null,
  contactInfo: { fullName: '', email: '' },
  roles: [],
  education: [],
  skills: { hard: [], soft: [], technical: [] },
  projects: [],
  certifications: [],
  generatedSummary: '',
  finalSummary: '',
  strengthScore: 0,
  strengthBreakdown: { contact: 0, experience: 0, education: 0, skills: 0, extras: 0 },
  aiCostUsd: 0,
  selectedTemplate: 'professional',
  fontFamily: 'georgia',
  fontSize: 'medium',
  headingSize: 18,
  bodySize: 9,
  isLoading: false,
  isSaving: false,
  isGeneratingFollowUps: false,
  isEnhancing: false,
  error: null,
}

// ─── Reducer ───────────────────────────────────────────────────────────────

function recalcStrength(state: WizardState): WizardState {
  const result: StrengthResult = calculateStrengthScore({
    contactInfo: state.contactInfo,
    roles: state.roles,
    education: state.education,
    skills: state.skills,
    projects: state.projects,
    certifications: state.certifications,
    finalSummary: state.finalSummary,
    generatedSummary: state.generatedSummary,
  })
  return { ...state, strengthScore: result.total, strengthBreakdown: result.breakdown }
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  let next: WizardState

  switch (action.type) {
    case 'SET_SESSION_ID':
      return { ...state, sessionId: action.sessionId }

    case 'SET_STAGE':
      return { ...state, stage: action.stage }

    case 'SET_SEGMENT':
      return recalcStrength({ ...state, segment: action.segment })

    case 'SET_CONTACT':
      next = { ...state, contactInfo: action.contactInfo }
      return recalcStrength(next)

    case 'SET_ROLES':
      next = { ...state, roles: action.roles }
      return recalcStrength(next)

    case 'UPDATE_ROLE': {
      const roles = state.roles.map(r =>
        r.id === action.roleId ? { ...r, ...action.data } : r
      )
      return recalcStrength({ ...state, roles })
    }

    case 'ADD_ROLE':
      next = { ...state, roles: [...state.roles, action.role] }
      return recalcStrength(next)

    case 'REMOVE_ROLE':
      next = { ...state, roles: state.roles.filter(r => r.id !== action.roleId) }
      return recalcStrength(next)

    case 'SET_FOLLOW_UPS': {
      const roles = state.roles.map(r =>
        r.id === action.roleId
          ? { ...r, followUpQuestions: action.questions.map(q => ({ question: q, answer: '' })) }
          : r
      )
      return { ...state, roles }
    }

    case 'SET_FOLLOW_UP_ANSWER': {
      const roles = state.roles.map(r => {
        if (r.id !== action.roleId) return r
        const fqs = [...r.followUpQuestions]
        if (fqs[action.questionIndex]) {
          fqs[action.questionIndex] = { ...fqs[action.questionIndex], answer: action.answer }
        }
        return { ...r, followUpQuestions: fqs }
      })
      return recalcStrength({ ...state, roles })
    }

    case 'SET_EDUCATION':
      next = { ...state, education: action.education }
      return recalcStrength(next)

    case 'SET_SKILLS':
      next = { ...state, skills: action.skills }
      return recalcStrength(next)

    case 'SET_PROJECTS':
      next = { ...state, projects: action.projects }
      return recalcStrength(next)

    case 'SET_CERTIFICATIONS':
      next = { ...state, certifications: action.certifications }
      return recalcStrength(next)

    case 'SET_ENHANCED': {
      const roles = state.roles.map(r =>
        r.id === action.roleId ? { ...r, enhancedBullets: action.enhanced } : r
      )
      return { ...state, roles }
    }

    case 'SET_ALL_ENHANCED': {
      const roles = state.roles.map(r => {
        const match = action.roles.find(e => e.roleId === r.id)
        return match ? { ...r, enhancedBullets: match.enhanced } : r
      })
      return { ...state, roles, generatedSummary: action.summary }
    }

    case 'SET_BULLET_DECISION': {
      const roles = state.roles.map(r => {
        if (r.id !== action.roleId) return r
        const existing = r.bulletDecisions.filter(d => d.index !== action.bulletIndex)
        return {
          ...r,
          bulletDecisions: [...existing, { index: action.bulletIndex, decision: action.decision, editedText: action.editedText }],
        }
      })
      return recalcStrength({ ...state, roles })
    }

    case 'SET_SUMMARY_DECISION':
      if (action.decision === 'accept') {
        return recalcStrength({ ...state, finalSummary: state.generatedSummary })
      } else if (action.decision === 'edit' && action.editedSummary) {
        return recalcStrength({ ...state, finalSummary: action.editedSummary })
      }
      return recalcStrength({ ...state, finalSummary: '' })

    case 'SET_TEMPLATE':
      return { ...state, selectedTemplate: action.template }

    case 'SET_FONT_FAMILY':
      return { ...state, fontFamily: action.fontFamily }

    case 'SET_FONT_SIZE':
      return { ...state, fontSize: action.fontSize }

    case 'SET_HEADING_SIZE':
      return { ...state, headingSize: action.headingSize }

    case 'SET_BODY_SIZE':
      return { ...state, bodySize: action.bodySize }

    case 'SET_UI_FLAG':
      return { ...state, [action.key]: action.value }
    case 'SET_ERROR':
      return { ...state, error: action.error }
    case 'SET_COST':
      return { ...state, aiCostUsd: action.aiCostUsd }

    case 'LOAD_SESSION':
      return recalcStrength({ ...state, ...action.session, isLoading: false })

    default:
      return state
  }
}

// ─── localStorage ──────────────────────────────────────────────────────────
// Wizard drafts are scoped by userId so that a draft left by one user on a
// shared browser cannot be hydrated into another user's wizard — fixing a
// PII leak where the wizard would load Stage 6/7 data belonging to whoever
// previously used the device.
//
// Legacy global key: `wizardDraft`          (unscoped; purged on first load)
// Current key:       `wizardDraft:{userId}`

const LEGACY_STORAGE_KEY = 'wizardDraft'

function storageKeyFor(userId: string | null | undefined): string | null {
  if (!userId) return null
  return `${LEGACY_STORAGE_KEY}:${userId}`
}

function saveToStorage(state: WizardState, key: string) {
  try {
    const { isLoading, isSaving, isGeneratingFollowUps, isEnhancing, error, ...data } = state
    localStorage.setItem(key, JSON.stringify(data))
  } catch { /* ignore */ }
}

function loadFromStorage(key: string): Partial<WizardState> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function clearStorage(key: string) {
  try {
    localStorage.removeItem(key)
  } catch { /* ignore */ }
}

/** One-time cleanup: drop the legacy unscoped `wizardDraft` key on mount.
 *  We cannot know whose data it belongs to, and blindly migrating it into
 *  the current user's scope would reintroduce the leak. It's safer to
 *  discard it — the worst case is a user loses a draft they never got to
 *  save anyway. */
function purgeLegacyStorage() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch { /* ignore */ }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useWizard(initialSessionId?: string) {
  const [state, dispatch] = useReducer(wizardReducer, initialState)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { data: session } = useSession()
  const userId = session?.user?.id ?? null
  const storageKey = storageKeyFor(userId)

  // Auto-save to localStorage (debounced), scoped to the current user.
  // If there's no user, skip persistence entirely — the wizard is auth-gated
  // at the page level, but we defend in depth here.
  useEffect(() => {
    if (!state.sessionId || !storageKey) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const key = storageKey
    saveTimerRef.current = setTimeout(() => saveToStorage(state, key), 500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [state, storageKey])

  // Load session on mount — only hydrate a draft that was saved under the
  // CURRENT user's id. Also purge any legacy unscoped `wizardDraft` key so
  // stale cross-user data cannot leak on subsequent sessions.
  useEffect(() => {
    purgeLegacyStorage()
    if (initialSessionId) {
      loadSession(initialSessionId)
      return
    }
    if (!storageKey) return
    const saved = loadFromStorage(storageKey)
    if (saved?.sessionId) {
      dispatch({ type: 'LOAD_SESSION', session: saved })
    }
  // Re-run when the user id changes (e.g. sign-in or account switch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  // ─── API Calls ─────────────────────────────────────────────────────────

  const createSession = useCallback(async (segment: WizardSegment) => {
    dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: true })
    dispatch({ type: 'SET_ERROR', error: null })
    try {
      const res = await fetch('/api/resume-wizard/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment }),
      })
      if (!res.ok) throw new Error('Failed to create session')
      const data = await res.json()
      dispatch({ type: 'SET_SESSION_ID', sessionId: data.sessionId })
      dispatch({ type: 'SET_SEGMENT', segment })
      dispatch({ type: 'SET_STAGE', stage: 1 })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to create session' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: false })
    }
  }, [])

  const loadSession = useCallback(async (sessionId: string) => {
    dispatch({ type: 'SET_UI_FLAG', key: 'isLoading', value: true })
    try {
      const res = await fetch(`/api/resume-wizard/session/${sessionId}`)
      if (!res.ok) throw new Error('Session not found')
      const { session } = await res.json()
      dispatch({
        type: 'LOAD_SESSION',
        session: {
          sessionId: session._id,
          stage: session.currentStage,
          segment: session.segment,
          contactInfo: session.contactInfo || { fullName: '', email: '' },
          roles: session.roles || [],
          education: session.education || [],
          skills: session.skills || { hard: [], soft: [], technical: [] },
          projects: session.projects || [],
          certifications: session.certifications || [],
          generatedSummary: session.generatedSummary || '',
          finalSummary: session.finalSummary || '',
          aiCostUsd: session.aiCostUsd || 0,
          selectedTemplate: session.selectedTemplate || 'professional',
        },
      })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to load session' })
      dispatch({ type: 'SET_UI_FLAG', key: 'isLoading', value: false })
    }
  }, [])

  const submitStage = useCallback(async (stageData: Record<string, unknown>) => {
    if (!state.sessionId) return
    dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: true })
    dispatch({ type: 'SET_ERROR', error: null })
    try {
      const res = await fetch('/api/resume-wizard/stage/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, data: stageData }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to save')
      }
      const result = await res.json()
      dispatch({ type: 'SET_STAGE', stage: result.currentStage })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to save' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: false })
    }
  }, [state.sessionId])

  const generateFollowUps = useCallback(async (roleId: string, jobTitle: string, rawDescription: string, company?: string) => {
    if (!state.sessionId) return
    dispatch({ type: 'SET_UI_FLAG', key: 'isGeneratingFollowUps', value: true })
    try {
      const res = await fetch('/api/resume-wizard/follow-ups/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, roleId, jobTitle, rawDescription, company }),
      })
      if (!res.ok) throw new Error('Failed to generate follow-ups')
      const data = await res.json()
      dispatch({ type: 'SET_FOLLOW_UPS', roleId, questions: data.questions })
      if (data.cost) dispatch({ type: 'SET_COST', aiCostUsd: state.aiCostUsd + data.cost })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to generate questions' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isGeneratingFollowUps', value: false })
    }
  }, [state.sessionId, state.aiCostUsd])

  const enhanceBullets = useCallback(async () => {
    if (!state.sessionId) return
    dispatch({ type: 'SET_UI_FLAG', key: 'isEnhancing', value: true })
    dispatch({ type: 'SET_ERROR', error: null })
    try {
      const res = await fetch('/api/resume-wizard/ai/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId }),
      })
      if (!res.ok) throw new Error('Enhancement failed')
      const data = await res.json()
      dispatch({
        type: 'SET_ALL_ENHANCED',
        roles: data.enhancedRoles.map((r: { roleId: string; enhanced: string[] }) => ({
          roleId: r.roleId,
          enhanced: r.enhanced,
        })),
        summary: data.summary,
      })
      if (data.totalCost) dispatch({ type: 'SET_COST', aiCostUsd: data.totalCost })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Enhancement failed' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isEnhancing', value: false })
    }
  }, [state.sessionId])

  const submitReview = useCallback(async () => {
    if (!state.sessionId) return
    dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: true })
    dispatch({ type: 'SET_ERROR', error: null })

    const bulletDecisions = state.roles.flatMap(r =>
      r.bulletDecisions.map(d => ({
        roleId: r.id,
        bulletIndex: d.index,
        decision: d.decision,
        editedText: d.editedText,
      }))
    )

    const summaryDecision = state.finalSummary
      ? (state.finalSummary === state.generatedSummary ? 'accept' : 'edit')
      : 'reject'

    try {
      const res = await fetch('/api/resume-wizard/stage/review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          bulletDecisions,
          summaryDecision,
          editedSummary: summaryDecision === 'edit' ? state.finalSummary : undefined,
        }),
      })
      if (!res.ok) throw new Error('Review submission failed')
      const result = await res.json()
      dispatch({ type: 'SET_STAGE', stage: result.currentStage })
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Review failed' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: false })
    }
  }, [state.sessionId, state.roles, state.finalSummary, state.generatedSummary])

  const exportResume = useCallback(async () => {
    if (!state.sessionId) return
    dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: true })
    dispatch({ type: 'SET_ERROR', error: null })
    try {
      const res = await fetch('/api/resume-wizard/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          template: state.selectedTemplate,
          format: 'pdf',
          fontFamily: state.fontFamily,
          fontSize: state.fontSize,
          headingSize: state.headingSize,
          bodySize: state.bodySize,
        }),
      })

      if (!res.ok) throw new Error('Export failed')

      const contentType = res.headers.get('Content-Type')
      if (contentType?.includes('application/pdf')) {
        // Server generated PDF successfully — trigger download
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `Resume_${state.contactInfo.fullName.replace(/\s+/g, '_') || 'Resume'}.pdf`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        if (storageKey) clearStorage(storageKey)
      } else {
        // PDF generation unavailable on server — use browser print fallback
        const data = await res.json()
        if (data.html) {
          // Server returned renderable HTML — open in new window for print-to-PDF
          const printWindow = window.open('', '_blank')
          if (printWindow) {
            printWindow.document.write(data.html)
            printWindow.document.close()
            // Short delay to let fonts/styles load before print dialog
            setTimeout(() => printWindow.print(), 500)
          } else {
            dispatch({ type: 'SET_ERROR', error: 'Pop-up blocked. Please allow pop-ups and try again.' })
          }
          if (storageKey) clearStorage(storageKey)
        } else {
          // Resume was saved but no PDF or HTML returned
          if (storageKey) clearStorage(storageKey)
          dispatch({
            type: 'SET_ERROR',
            error: data.message || 'Resume saved to your dashboard but PDF download is temporarily unavailable. Use browser print (Ctrl+P) on the preview.',
          })
        }
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Export failed' })
    } finally {
      dispatch({ type: 'SET_UI_FLAG', key: 'isSaving', value: false })
    }
  }, [state.sessionId, state.selectedTemplate, state.contactInfo.fullName, state.fontFamily, state.fontSize, state.headingSize, state.bodySize, storageKey])

  // ─── Navigation ────────────────────────────────────────────────────────

  const goBack = useCallback(() => {
    if (state.stage > 0) {
      dispatch({ type: 'SET_STAGE', stage: state.stage - 1 })
    }
  }, [state.stage])

  const resetWizard = useCallback(() => {
    if (storageKey) clearStorage(storageKey)
    dispatch({ type: 'LOAD_SESSION', session: initialState })
  }, [storageKey])

  return {
    state,
    dispatch,
    // API calls
    createSession,
    loadSession,
    submitStage,
    generateFollowUps,
    enhanceBullets,
    submitReview,
    exportResume,
    // Navigation
    goBack,
    resetWizard,
  }
}
