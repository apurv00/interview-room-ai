'use client'

import { useEffect, useState } from 'react'

interface SlotConfig {
  taskSlot: string
  model: string
  fallbackModel: string
  maxTokens: number
  provider: 'anthropic' | 'openrouter'
  temperature: number | undefined
  isActive: boolean
}

interface Defaults {
  [key: string]: { model: string; maxTokens: number; provider: string }
}

export default function ModelConfigPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [openRouterEnabled, setOpenRouterEnabled] = useState(false)
  const [slots, setSlots] = useState<SlotConfig[]>([])
  const [taskSlots, setTaskSlots] = useState<string[]>([])
  const [defaults, setDefaults] = useState<Defaults>({})

  useEffect(() => {
    fetch('/api/cms/model-config')
      .then(r => r.ok ? r.json() : Promise.reject('Failed to load'))
      .then(data => {
        setTaskSlots(data.taskSlots)
        setDefaults(data.defaults)
        setOpenRouterEnabled(data.config.openRouterEnabled || false)

        // Merge existing config with all available task slots
        const existingSlots = new Map<string, SlotConfig>()
        for (const s of data.config.slots || []) {
          existingSlots.set(s.taskSlot, {
            taskSlot: s.taskSlot,
            model: s.model,
            fallbackModel: s.fallbackModel || '',
            maxTokens: s.maxTokens,
            provider: s.provider,
            temperature: s.temperature,
            isActive: s.isActive,
          })
        }

        // Build full slot list from all registered task slots
        const fullSlots: SlotConfig[] = data.taskSlots.map((ts: string) => {
          const existing = existingSlots.get(ts)
          const def = data.defaults[ts]
          return existing || {
            taskSlot: ts,
            model: def?.model || '',
            fallbackModel: '',
            maxTokens: def?.maxTokens || 1000,
            provider: 'anthropic' as const,
            temperature: undefined,
            isActive: false,
          }
        })
        setSlots(fullSlots)
      })
      .catch(() => setError('Failed to load model config. Are you logged in as admin?'))
      .finally(() => setLoading(false))
  }, [])

  function updateSlot(idx: number, field: keyof SlotConfig, value: string | number | boolean | undefined) {
    setSlots(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      // Only send active slots to DB
      const payload = {
        openRouterEnabled,
        slots: slots.filter(s => s.isActive).map(s => ({
          taskSlot: s.taskSlot,
          model: s.model,
          fallbackModel: s.fallbackModel || undefined,
          maxTokens: s.maxTokens,
          provider: s.provider,
          temperature: s.temperature ?? undefined,
          isActive: true,
        })),
      }
      const res = await fetch('/api/cms/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setSuccess('Model config saved. Changes take effect within 60 seconds.')
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to save')
      }
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  // Group slots by category
  const categories = new Map<string, SlotConfig[]>()
  for (const s of slots) {
    const cat = s.taskSlot.split('.')[0]
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push(s)
  }

  if (loading) return <div className="text-[#536471]">Loading model config...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Model Configuration</h2>
          <p className="text-sm text-[#536471] mt-1">Configure AI model routing per task. Changes apply within 60s.</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-[#2563eb] text-white rounded-lg font-medium hover:bg-[#1d4ed8] disabled:opacity-50 transition"
        >
          {saving ? 'Saving...' : 'Save Config'}
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">{success}</div>}

      {/* Global toggle */}
      <div className="bg-white border border-[#e1e8ed] rounded-xl p-5 flex items-center justify-between">
        <div>
          <p className="font-medium text-[#0f1419]">OpenRouter Routing</p>
          <p className="text-sm text-[#536471]">
            When enabled, active slots route through OpenRouter. When disabled, all calls use hardcoded Anthropic defaults.
          </p>
        </div>
        <button
          onClick={() => setOpenRouterEnabled(!openRouterEnabled)}
          className={`relative w-12 h-6 rounded-full transition-colors ${openRouterEnabled ? 'bg-[#2563eb]' : 'bg-[#cfd9de]'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${openRouterEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* Per-category slot configuration */}
      {Array.from(categories.entries()).map(([cat, catSlots]) => (
        <div key={cat} className="bg-white border border-[#e1e8ed] rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-[#f7f9f9] border-b border-[#e1e8ed]">
            <h3 className="font-semibold text-[#0f1419] capitalize">{cat}</h3>
          </div>
          <div className="divide-y divide-[#e1e8ed]">
            {catSlots.map((slot) => {
              const idx = slots.indexOf(slot)
              const def = defaults[slot.taskSlot]
              const taskLabel = slot.taskSlot.split('.')[1].replace(/-/g, ' ')
              return (
                <div key={slot.taskSlot} className={`p-5 space-y-3 ${slot.isActive ? '' : 'opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-[#0f1419] capitalize">{taskLabel}</p>
                      <p className="text-xs text-[#71767b]">
                        Default: {def?.model} ({def?.maxTokens} tokens)
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-[#536471] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={slot.isActive}
                        onChange={e => updateSlot(idx, 'isActive', e.target.checked)}
                        className="w-4 h-4 rounded border-[#cfd9de]"
                      />
                      Override
                    </label>
                  </div>

                  {slot.isActive && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs text-[#71767b] mb-1">Primary Model</label>
                        <input
                          type="text"
                          value={slot.model}
                          onChange={e => updateSlot(idx, 'model', e.target.value)}
                          placeholder="e.g. anthropic/claude-sonnet-4-6"
                          className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-[#71767b] mb-1">Fallback Model</label>
                        <input
                          type="text"
                          value={slot.fallbackModel}
                          onChange={e => updateSlot(idx, 'fallbackModel', e.target.value)}
                          placeholder="e.g. anthropic/claude-haiku-4-5"
                          className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-[#71767b] mb-1">Provider</label>
                        <select
                          value={slot.provider}
                          onChange={e => updateSlot(idx, 'provider', e.target.value)}
                          className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                        >
                          <option value="anthropic">Anthropic (direct)</option>
                          <option value="openrouter">OpenRouter</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-[#71767b] mb-1">Max Tokens</label>
                        <input
                          type="number"
                          value={slot.maxTokens}
                          onChange={e => updateSlot(idx, 'maxTokens', parseInt(e.target.value) || 500)}
                          className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-[#71767b] mb-1">Temperature (optional)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={slot.temperature ?? ''}
                          onChange={e => updateSlot(idx, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)}
                          placeholder="Provider default"
                          className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
