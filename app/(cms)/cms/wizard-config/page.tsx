'use client'

import { useEffect, useState } from 'react'

export default function WizardConfigPage() {
  const [costCapEnabled, setCostCapEnabled] = useState(true)
  const [costCapUsd, setCostCapUsd] = useState(1.0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/cms/wizard-config')
      .then(r => r.json())
      .then(data => {
        if (data.config) {
          setCostCapEnabled(data.config.costCapEnabled)
          setCostCapUsd(data.config.costCapUsd)
        }
      })
      .catch(() => setMessage({ type: 'error', text: 'Failed to load config' }))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/cms/wizard-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costCapEnabled, costCapUsd }),
      })
      if (!res.ok) {
        const data = await res.json()
        setMessage({ type: 'error', text: data.error || 'Failed to save' })
      } else {
        setMessage({ type: 'success', text: 'Wizard config updated successfully' })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-[#0f1419] mb-1">Wizard Config</h1>
      <p className="text-sm text-[#536471] mb-8">
        Global settings for the Smart Resume Wizard AI cost controls.
      </p>

      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-6">
        {/* Cost Cap Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-[#0f1419]">AI Cost Cap</label>
            <p className="text-xs text-[#8b98a5] mt-0.5">
              Limit AI spending per wizard session. When disabled, AI calls have no cost limit.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={costCapEnabled}
            onClick={() => setCostCapEnabled(!costCapEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
              costCapEnabled ? 'bg-indigo-600' : 'bg-[#f7f9f9]'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${
                costCapEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Cost Cap Amount */}
        <div className={costCapEnabled ? '' : 'opacity-50 pointer-events-none'}>
          <label className="block text-sm font-medium text-[#0f1419] mb-1">
            Cost Cap (USD)
          </label>
          <p className="text-xs text-[#8b98a5] mb-2">
            Maximum AI spend per wizard session before falling back to default questions.
          </p>
          <div className="relative w-40">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#536471] text-sm">$</span>
            <input
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={costCapUsd}
              onChange={e => setCostCapUsd(parseFloat(e.target.value) || 0.01)}
              className="w-full pl-7 pr-3 py-2 bg-[#f7f9f9] border border-[#e1e8ed] rounded-lg text-[#0f1419] text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Message */}
        {message && (
          <div className={`text-sm px-3 py-2 rounded-lg ${
            message.type === 'success'
              ? 'bg-green-900/30 text-green-400 border border-green-800'
              : 'bg-red-900/30 text-red-400 border border-red-800'
          }`}>
            {message.text}
          </div>
        )}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
