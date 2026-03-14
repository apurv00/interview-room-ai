'use client'

import Input from '@shared/ui/Input'
import Button from '@shared/ui/Button'
import type { WizardRole } from '../hooks/useWizard'

interface Props {
  roles: WizardRole[]
  currentRoleIndex: number
  isGenerating: boolean
  onGenerateFollowUps: (roleId: string, jobTitle: string, rawDescription: string, company?: string) => void
  onAnswerChange: (roleId: string, questionIndex: number, answer: string) => void
  onBack: () => void
  onNextRole: () => void
  onDone: () => void
}

export default function StageFollowUps({
  roles, currentRoleIndex, isGenerating, onGenerateFollowUps, onAnswerChange, onBack, onNextRole, onDone,
}: Props) {
  const role = roles[currentRoleIndex]
  if (!role) return null

  const hasQuestions = role.followUpQuestions.length > 0
  const hasMoreRoles = currentRoleIndex < roles.length - 1

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-white">Follow-Up Questions</h2>
          <span className="text-xs text-[#4b5563]">
            Role {currentRoleIndex + 1} of {roles.length}
          </span>
        </div>
        <p className="text-sm text-[#6b7280]">
          Help us add metrics and impact to your <span className="text-white font-medium">{role.title || 'role'}</span>
          {role.company ? <> at <span className="text-white font-medium">{role.company}</span></> : ''}
        </p>
      </div>

      {!hasQuestions && !isGenerating && (
        <div className="text-center py-6 space-y-3">
          <p className="text-sm text-[#4b5563]">
            Generate AI-powered questions to extract key achievements
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack}>
              Back
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => onGenerateFollowUps(
                role.id,
                role.title,
                role.rawBullets.join('. '),
                role.company,
              )}
              isLoading={isGenerating}
            >
              Generate Questions
            </Button>
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="flex items-center gap-3 p-4 bg-surface rounded-xl border border-[rgba(255,255,255,0.06)]">
          <div className="w-5 h-5 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
          <span className="text-sm text-[#6b7280]">Generating personalized questions...</span>
        </div>
      )}

      {hasQuestions && !isGenerating && (
        <div className="space-y-4">
          {role.followUpQuestions.map((fq, i) => (
            <div key={i} className="bg-surface border border-[rgba(255,255,255,0.06)] rounded-xl p-4 space-y-2">
              <p className="text-sm text-white font-medium">{fq.question}</p>
              <Input
                value={fq.answer}
                onChange={e => onAnswerChange(role.id, i, e.target.value)}
                placeholder="Type your answer... (optional but helps a lot)"
              />
            </div>
          ))}

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onBack}>
                Back
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onGenerateFollowUps(
                  role.id,
                  role.title,
                  role.rawBullets.join('. '),
                  role.company,
                )}
                isLoading={isGenerating}
              >
                Regenerate
              </Button>
            </div>
            {hasMoreRoles ? (
              <Button variant="primary" size="sm" onClick={onNextRole}>
                Next Role
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={onDone}>
                Continue
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
