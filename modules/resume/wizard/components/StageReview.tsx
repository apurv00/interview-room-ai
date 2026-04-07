'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import Button from '@shared/ui/Button'
import { Sparkles } from 'lucide-react'
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
          <h2 className="text-xl font-bold text-slate-900">AI Enhancement</h2>
          <p className="text-sm text-slate-500">
            Let AI transform your descriptions into powerful, ATS-optimized bullet points
          </p>
        </div>
        <div className="text-center py-8 space-y-4">
          <div className="w-16 h-16 rounded-full bg-blue-600/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-8 h-8 text-blue-600" strokeWidth={1.5} />
          </div>
          <p className="text-sm text-slate-500">
            AI will enhance your bullets with action verbs, metrics, and professional language
          </p>
          <Button variant="primary" size="lg" glow onClick={onEnhance}>
            Enhance My Resume
          </Button>
          <p className="text-[10px] text-slate-400">
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
          <h2 className="text-xl font-bold text-slate-900">AI Enhancement</h2>
          <p className="text-sm text-slate-500">Enhancing your bullet points...</p>
        </div>
        <div className="flex flex-col items-center gap-4 py-12">
          <div className="w-10 h-10 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
          <p className="text-sm text-slate-500">AI is polishing your resume bullets and writing your summary...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Review AI Suggestions</h2>
        <p className="text-sm text-slate-500">Accept, edit, or reject each enhancement</p>
      </div>

      {/* Bullets per role */}
      {roles.map(role => (
        <div key={role.id} className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">
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
                      : 'border-slate-200 bg-slate-100'
                }`}
              >
                {/* Original */}
                <div className="space-y-1">
                  <span className="text-[9px] uppercase tracking-wide text-slate-400">Original</span>
                  <p className="text-xs text-slate-500 line-through">{raw}</p>
                </div>

                {/* Enhanced */}
                <div className="space-y-1">
                  <span className="text-[9px] uppercase tracking-wide text-blue-600">Enhanced</span>
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={2}
                        className="w-full bg-white text-sm text-slate-900 border border-blue-600/30 rounded-md px-3 py-2 focus:outline-none resize-none"
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
                    <p className="text-xs text-slate-900">
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
                          : 'bg-slate-100 text-slate-500 hover:text-[#059669]'
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
                          ? 'bg-blue-600/20 text-blue-600'
                          : 'bg-slate-100 text-slate-500 hover:text-blue-600'
                      }`}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onBulletDecision(role.id, i, 'reject')}
                      className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
                        decision?.decision === 'reject'
                          ? 'bg-[rgba(239,68,68,0.15)] text-[#f87171]'
                          : 'bg-slate-100 text-slate-500 hover:text-[#f87171]'
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
        <div className="space-y-3 pt-4 border-t border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Professional Summary</h3>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea
                value={summaryText}
                onChange={e => setSummaryText(e.target.value)}
                rows={3}
                className="w-full bg-slate-100 text-sm text-slate-900 border border-blue-600/30 rounded-xl px-3 py-2 focus:outline-none resize-none"
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
              <p className="text-sm text-slate-500 bg-slate-100 border border-slate-200 rounded-xl p-3">
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

      <p className="text-[10px] text-slate-400 text-right">
        AI cost: ${aiCostUsd.toFixed(3)}
      </p>
    </div>
  )
}
