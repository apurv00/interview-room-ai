'use client'

import { useState, useCallback } from 'react'
import { MessageCircleQuestion, Send, Loader2 } from 'lucide-react'
import type { CodingClarificationRecord } from '@interview/validators/clarifyCoding'

interface ClarificationsPanelProps {
  clarifications: CodingClarificationRecord[]
  onAsk: (question: string) => Promise<void>
  disabled?: boolean
}

export default function ClarificationsPanel({
  clarifications,
  onAsk,
  disabled = false,
}: ClarificationsPanelProps) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed || busy || disabled) return
    setBusy(true)
    setError(null)
    try {
      await onAsk(trimmed)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ask the interviewer')
    } finally {
      setBusy(false)
    }
  }, [draft, busy, disabled, onAsk])

  return (
    <div className="border-t border-gray-700 pt-3 mt-3 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">
        <MessageCircleQuestion className="w-3.5 h-3.5" />
        Clarifications
      </div>

      {clarifications.length > 0 && (
        <div className="space-y-2.5">
          {clarifications.map((c, i) => (
            <div
              key={`${c.createdAt}-${i}`}
              data-testid="clarification-entry"
              className="bg-gray-800/60 rounded-md p-3 space-y-2 border border-gray-700/50"
            >
              <p className="text-sm text-purple-200">
                <span className="font-semibold text-purple-300">You: </span>
                {c.question}
              </p>
              <p className="text-sm text-blue-100">
                <span className="font-semibold text-blue-300">Alex: </span>
                {c.answer}
              </p>
              {c.addedExamples && c.addedExamples.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-[11px] font-semibold text-emerald-300/80 uppercase tracking-wide">
                    New example
                  </p>
                  {c.addedExamples.map((ex, j) => (
                    <div key={j} className="bg-gray-900/60 rounded px-2.5 py-2 text-xs space-y-0.5">
                      <div>
                        <span className="text-gray-400">Input: </span>
                        <code className="text-white font-mono">{ex.input}</code>
                      </div>
                      <div>
                        <span className="text-gray-400">Output: </span>
                        <code className="text-emerald-300 font-mono">{ex.output}</code>
                      </div>
                      {ex.explanation && (
                        <div className="text-gray-300 italic">{ex.explanation}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {c.addedConstraints && c.addedConstraints.length > 0 && (
                <div className="space-y-1 pt-1">
                  <p className="text-[11px] font-semibold text-amber-300/80 uppercase tracking-wide">
                    New constraint
                  </p>
                  <ul className="space-y-0.5">
                    {c.addedConstraints.map((cn, j) => (
                      <li key={j} className="text-xs text-amber-100 font-mono">
                        {cn}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask the interviewer to clarify… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={disabled || busy}
          className="flex-1 resize-none rounded-md border border-gray-700 bg-gray-900/80 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || busy || !draft.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 px-3 py-2 text-sm font-medium text-white transition-colors"
          aria-label="Ask the interviewer"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Ask
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
