'use client'

import { useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Button from '@shared/ui/Button'
import { useWizard } from '../hooks/useWizard'
import WizardProgressBar from './WizardProgressBar'
import WizardPreview from './WizardPreview'
import StageSegment from './StageSegment'
import StageContact from './StageContact'
import StageExperience from './StageExperience'
import StageFollowUps from './StageFollowUps'
import StageEducation from './StageEducation'
import StageSkills from './StageSkills'
import StageExtras from './StageExtras'
import StageReview from './StageReview'
import StageExport from './StageExport'

interface Props {
  initialSessionId?: string
}

export default function WizardShell({ initialSessionId }: Props) {
  const {
    state, dispatch,
    createSession, submitStage, generateFollowUps, enhanceBullets, submitReview, exportResume, goBack, resetWizard,
  } = useWizard(initialSessionId)

  const [mobileTab, setMobileTab] = useState<'wizard' | 'preview'>('wizard')
  const [followUpRoleIndex, setFollowUpRoleIndex] = useState(0)
  // Track if we're in the follow-up sub-stage (between stage 2 and 3)
  const [showFollowUps, setShowFollowUps] = useState(false)

  // ─── Stage Navigation ────────────────────────────────────────────────

  const canAdvance = useCallback((): boolean => {
    switch (state.stage) {
      case 0: return state.segment !== null
      case 1: return !!(state.contactInfo.fullName && state.contactInfo.email)
      case 2: return state.roles.length > 0 && state.roles.every(r => r.title.trim())
      case 3: return state.education.length > 0 && state.education.every(e => e.institution.trim() && e.degree.trim())
      case 4: {
        const totalSkills = state.skills.hard.length + state.skills.soft.length + state.skills.technical.length
        return totalSkills >= 1
      }
      case 5: return true // optional stage
      case 6: return true // review is flexible
      default: return false
    }
  }, [state])

  const handleNext = useCallback(async () => {
    if (!canAdvance()) return

    // Stage 0: Create session
    if (state.stage === 0 && state.segment) {
      await createSession(state.segment)
      return
    }

    // Stage 2: After submitting roles, show follow-ups
    if (state.stage === 2 && !showFollowUps) {
      await submitStage({
        stage: 2,
        roles: state.roles.map(r => ({
          id: r.id,
          company: r.company,
          title: r.title,
          location: r.location,
          startDate: r.startDate,
          endDate: r.endDate,
          rawBullets: r.rawBullets.filter(b => b.trim()),
        })),
      })
      setShowFollowUps(true)
      setFollowUpRoleIndex(0)
      // Auto-generate for first role
      const firstRole = state.roles[0]
      if (firstRole) {
        generateFollowUps(firstRole.id, firstRole.title, firstRole.rawBullets.join('. '), firstRole.company)
      }
      return
    }

    // Other stages: submit and advance
    switch (state.stage) {
      case 1:
        await submitStage({ stage: 1, contactInfo: state.contactInfo })
        break
      case 3:
        await submitStage({ stage: 3, education: state.education })
        break
      case 4:
        await submitStage({ stage: 4, skills: state.skills })
        break
      case 5:
        await submitStage({
          stage: 5,
          projects: state.projects.filter(p => p.name.trim()),
          certifications: state.certifications.filter(c => c.name.trim()),
        })
        break
      case 6:
        await submitReview()
        break
    }
  }, [state, canAdvance, createSession, submitStage, generateFollowUps, submitReview, showFollowUps])

  const handleBack = useCallback(() => {
    if (showFollowUps) {
      setShowFollowUps(false)
      return
    }
    goBack()
  }, [showFollowUps, goBack])

  const handleFollowUpNextRole = useCallback(() => {
    const nextIndex = followUpRoleIndex + 1
    if (nextIndex < state.roles.length) {
      setFollowUpRoleIndex(nextIndex)
      const role = state.roles[nextIndex]
      if (role.followUpQuestions.length === 0) {
        generateFollowUps(role.id, role.title, role.rawBullets.join('. '), role.company)
      }
    }
  }, [followUpRoleIndex, state.roles, generateFollowUps])

  const handleFollowUpDone = useCallback(() => {
    setShowFollowUps(false)
    // Stage was already advanced to 3 by submitStage
  }, [])

  // ─── Stage Content ───────────────────────────────────────────────────

  function renderStage() {
    // Follow-up sub-stage
    if (showFollowUps && state.stage >= 2) {
      return (
        <StageFollowUps
          roles={state.roles}
          currentRoleIndex={followUpRoleIndex}
          isGenerating={state.isGeneratingFollowUps}
          onGenerateFollowUps={generateFollowUps}
          onAnswerChange={(roleId, qi, answer) =>
            dispatch({ type: 'SET_FOLLOW_UP_ANSWER', roleId, questionIndex: qi, answer })
          }
          onBack={handleBack}
          onNextRole={handleFollowUpNextRole}
          onDone={handleFollowUpDone}
        />
      )
    }

    switch (state.stage) {
      case 0:
        return (
          <StageSegment
            selected={state.segment}
            onSelect={seg => dispatch({ type: 'SET_SEGMENT', segment: seg })}
            isLoading={state.isSaving}
          />
        )

      case 1:
        return (
          <StageContact
            contactInfo={state.contactInfo}
            onChange={info => dispatch({ type: 'SET_CONTACT', contactInfo: info })}
          />
        )

      case 2:
        return (
          <StageExperience
            roles={state.roles}
            onAddRole={role => dispatch({ type: 'ADD_ROLE', role })}
            onUpdateRole={(id, data) => dispatch({ type: 'UPDATE_ROLE', roleId: id, data })}
            onRemoveRole={id => dispatch({ type: 'REMOVE_ROLE', roleId: id })}
          />
        )

      case 3:
        return (
          <StageEducation
            education={state.education}
            onChange={edu => dispatch({ type: 'SET_EDUCATION', education: edu })}
          />
        )

      case 4:
        return (
          <StageSkills
            skills={state.skills}
            onChange={skills => dispatch({ type: 'SET_SKILLS', skills })}
          />
        )

      case 5:
        return (
          <StageExtras
            projects={state.projects}
            certifications={state.certifications}
            onProjectsChange={p => dispatch({ type: 'SET_PROJECTS', projects: p })}
            onCertificationsChange={c => dispatch({ type: 'SET_CERTIFICATIONS', certifications: c })}
          />
        )

      case 6:
        return (
          <StageReview
            roles={state.roles}
            generatedSummary={state.generatedSummary}
            finalSummary={state.finalSummary}
            isEnhancing={state.isEnhancing}
            aiCostUsd={state.aiCostUsd}
            onEnhance={enhanceBullets}
            onBulletDecision={(roleId, idx, decision, editedText) =>
              dispatch({ type: 'SET_BULLET_DECISION', roleId, bulletIndex: idx, decision, editedText })
            }
            onSummaryDecision={(decision, editedSummary) =>
              dispatch({ type: 'SET_SUMMARY_DECISION', decision, editedSummary })
            }
          />
        )

      case 7:
        return (
          <StageExport
            selectedTemplate={state.selectedTemplate}
            strengthScore={state.strengthScore}
            strengthBreakdown={state.strengthBreakdown}
            isSaving={state.isSaving}
            fontFamily={state.fontFamily}
            headingSize={state.headingSize}
            bodySize={state.bodySize}
            onSelectTemplate={t => dispatch({ type: 'SET_TEMPLATE', template: t })}
            onFontFamilyChange={f => dispatch({ type: 'SET_FONT_FAMILY', fontFamily: f })}
            onHeadingSizeChange={s => dispatch({ type: 'SET_HEADING_SIZE', headingSize: s })}
            onBodySizeChange={s => dispatch({ type: 'SET_BODY_SIZE', bodySize: s })}
            onExport={exportResume}
          />
        )

      default:
        return null
    }
  }

  // ─── Loading State ───────────────────────────────────────────────────

  if (state.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto">
      {/* Progress Bar */}
      <div className="mb-6">
        <WizardProgressBar currentStage={state.stage} strengthScore={state.strengthScore} />
      </div>

      {/* Mobile tab switcher */}
      <div className="flex gap-1 mb-4 md:hidden">
        <button
          onClick={() => setMobileTab('wizard')}
          className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
            mobileTab === 'wizard' ? 'bg-[#2563eb] text-white' : 'bg-surface text-[#6b7280]'
          }`}
        >
          Edit
        </button>
        <button
          onClick={() => setMobileTab('preview')}
          className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
            mobileTab === 'preview' ? 'bg-[#2563eb] text-white' : 'bg-surface text-[#6b7280]'
          }`}
        >
          Preview
        </button>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6">
        {/* Left: Wizard forms */}
        <div className={`flex-1 min-w-0 ${mobileTab !== 'wizard' ? 'hidden md:block' : ''}`}>
          {/* Error banner */}
          {state.error && (
            <div className="mb-4 p-3 bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)] rounded-xl text-sm text-[#f87171]" role="alert">
              {state.error}
              <button
                onClick={() => dispatch({ type: 'SET_ERROR', error: null })}
                className="ml-2 text-[#f87171]/60 hover:text-[#f87171]"
              >
                dismiss
              </button>
            </div>
          )}

          {/* Stage content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={showFollowUps ? `followup-${followUpRoleIndex}` : `stage-${state.stage}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {renderStage()}
            </motion.div>
          </AnimatePresence>

          {/* Navigation buttons */}
          {!showFollowUps && (
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-[#e1e8ed]">
              <div>
                {state.stage > 0 && (
                  <Button variant="ghost" size="sm" onClick={handleBack} disabled={state.isSaving}>
                    Back
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {state.stage === 5 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => submitStage({ stage: 5 })}
                    disabled={state.isSaving}
                  >
                    Skip
                  </Button>
                )}
                {state.stage < 7 && state.stage !== 6 && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleNext}
                    disabled={!canAdvance() || state.isSaving}
                    isLoading={state.isSaving}
                  >
                    {state.stage === 0 ? 'Get Started' : 'Continue'}
                  </Button>
                )}
                {state.stage === 6 && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleNext}
                    disabled={state.isSaving || state.isEnhancing}
                    isLoading={state.isSaving}
                  >
                    Finalize & Export
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: Live Preview */}
        <div className={`w-[380px] shrink-0 sticky top-4 self-start ${mobileTab !== 'preview' ? 'hidden md:block' : ''}`}>
          <div className="bg-white border border-[#e1e8ed] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-medium text-[#8b98a5] uppercase tracking-wider">Live Preview</span>
            </div>
            <div className="transform scale-[0.55] origin-top-left" style={{ width: '182%', height: '500px', overflow: 'hidden' }}>
              <WizardPreview state={state} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
