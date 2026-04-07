'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import Button from '@shared/ui/Button'
import type { WizardRole } from '../hooks/useWizard'

interface Props {
  roles: WizardRole[]
  generatedSummary: string
  finalSummary: string
  isEnhancing: boolean
  aiCostUsd: number
  onEnhance: () => void
  onBulletDecision: (roleId: string, bulletIndex: number, decision: 'accept' | 'reject' | 'edit', editedText?: string) => void
  onSummaryDecision: (decision: 'accept' | 'reject' | 'edit', editedSummary?: string) => void
}

export default function StageReview({
  roles, generatedSummary, finalSummary, isEnhancing, aiCostUsd,
  onEnhance, onBulletDecision, onSummaryDecision,
}: Props) {
  const [editingBullet, setEditingBullet] = useState<string | null>(null) // "roleId-index"
  const [editText, setEditText] = useState('')
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryText, setSummaryText] = useState(finalSummary || generatedSummary)

  const hasEnhanced = roles.some(r => r.enhancedBullets.length > 0)

  if (!hasEnhanced && !isEnhancing) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-xl font-bold text-[#0f1419]">AI Enhancement</h2>
          <p className="text-sm text-[#6b7280]">
            Let AI transform your descriptions into powerful, ATS-optimized bullet points
          </p>
        </div>
        <div className="text-center py-8 space-y-4">
          <div className="w-16 h-16 rounded-full bg-[#2563eb]/10 flex items-center justify-center mx-auto">
            <svg className="w-8 h-8 text-[#2563eb]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
          </div>
          <p className="text-sm text-[#536471]">
            AI will enhance your bullets with action verbs, metrics, and professional language
          </p>
          <Button variant="primary" size="lg" glow onClick={onEnhance}>
            Enhance My Resume
          </Button>
          <p className="text-[10px] text-[#8b98a5]">
            Cost so far: ${aiCostUsd.toFixed(3)}
          </p>
        </div>
      </div>
    )
  }

  if (isEnhancing) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-xl font-bold text-[#0f1419]">AI Enhancement</h2>
          <p className="text-sm text-[#6b7280]">Enhancing your bullet points...</p>
        </div>
        <div className="flex flex-col items-center gap-4 py-12">
          <div className="w-10 h-10 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
          <p className="text-sm text-[#6b7280]">AI is polishing your resume bullets and writing your summary...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-[#0f1419]">Review AI Suggestions</h2>
        <p className="text-sm text-[#6b7280]">Accept, edit, or reject each enhancement</p>
      </div>

      {/* Bullets per role */}
      {roles.map(role => (
        <div key={role.id} className="space-y-3">
          <h3 className="text-sm font-semibold text-[#0f1419]">
            {role.title}{role.company ? ` at ${role.company}` : ''}
          </h3>

          {role.enhancedBullets.map((enhanced, i) => {
            const raw = role.rawBullets[i] || ''
            const decision = role.bulletDecisions.find(d => d.index === i)
            const bulletKey = `${role.id}-${i}`
            const isEditing = editingBullet === bulletKey

            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`rounded-xl border p-3 space-y-2 ${
                  decision?.decision === 'accept' ? 'border-emerald-500/30 bg-emerald-500/5'
                    : decision?.decision === 'reject' ? 'border-[rgba(239,68,68,0.15)] bg-[rgba(239,68,68,0.03)]'
                      : 'border-[#e1e8ed] bg-surface'
                }`}
              >
                {/* Original */}
                <div className="space-y-1">
                  <span className="text-[9px] uppercase tracking-wide text-[#8b98a5]">Original</span>
                  <p className="text-xs text-[#6b7280] line-through">{raw}</p>
                </div>

                {/* Enhanced */}
                <div className="space-y-1">
                  <span className="text-[9px] uppercase tracking-wide text-[#2563eb]">Enhanced</span>
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={2}
                        className="w-full bg-white text-sm text-[#0f1419] border border-[#2563eb]/30 rounded-md px-3 py-2 focus:outline-none resize-none"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => {
                          onBulletDecision(role.id, i, 'edit', editText)
                          setEditingBullet(null)
                        }}>
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingBullet(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-[#0f1419]">
                      {decision?.decision === 'edit' ? decision.editedText : enhanced}
                    </p>
                  )}
                </div>

                {/* Action buttons */}
                {!isEditing && (
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => onBulletDecision(role.id, i, 'accept')}
                      className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                        decision?.decision === 'accept'
                          ? 'bg-emerald-500/20 text-[#059669]'
                          : 'bg-surface text-[#6b7280] hover:text-[#059669]'
                      }`}
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => {
                        setEditingBullet(bulletKey)
                        setEditText(decision?.editedText || enhanced)
                      }}
                      className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                        decision?.decision === 'edit'
                          ? 'bg-[#2563eb]/20 text-[#2563eb]'
                          : 'bg-surface text-[#6b7280] hover:text-[#2563eb]'
                      }`}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onBulletDecision(role.id, i, 'reject')}
                      className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                        decision?.decision === 'reject'
                          ? 'bg-[rgba(239,68,68,0.15)] text-[#f87171]'
                          : 'bg-surface text-[#6b7280] hover:text-[#f87171]'
                      }`}
                    >
                      Keep Original
                    </button>
                  </div>
                )}
              </motion.div>
            )
          })}
        </div>
      ))}

      {/* Summary */}
      {generatedSummary && (
        <div className="space-y-3 pt-4 border-t border-[#e1e8ed]">
          <h3 className="text-sm font-semibold text-[#0f1419]">Professional Summary</h3>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea
                value={summaryText}
                onChange={e => setSummaryText(e.target.value)}
                rows={3}
                className="w-full bg-surface text-sm text-[#0f1419] border border-[#2563eb]/30 rounded-xl px-3 py-2 focus:outline-none resize-none"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => {
                  onSummaryDecision('edit', summaryText)
                  setEditingSummary(false)
                }}>
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingSummary(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-[#536471] bg-surface border border-[#e1e8ed] rounded-xl p-3">
                {finalSummary || generatedSummary}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={finalSummary === generatedSummary ? 'primary' : 'secondary'}
                  onClick={() => onSummaryDecision('accept')}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSummaryText(finalSummary || generatedSummary)
                    setEditingSummary(true)
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSummaryDecision('reject')}
                >
                  Skip Summary
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-[#8b98a5] text-right">
        AI cost: ${aiCostUsd.toFixed(3)}
      </p>
    </div>
  )
}
