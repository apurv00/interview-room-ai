'use client'

import { useEffect, useState } from 'react'

interface ProviderInfo {
  name: string
  label: string
  configured: boolean
}

interface SlotConfig {
  taskSlot: string
  model: string
  provider: string
  fallbackModel: string
  fallbackProvider: string
  maxTokens: number
  temperature: number | undefined
  isActive: boolean
  useToonInput: boolean
}

interface Defaults {
  [key: string]: { model: string; maxTokens: number; provider: string }
}

export default function ModelConfigPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [routingEnabled, setRoutingEnabled] = useState(false)
  const [slots, setSlots] = useState<SlotConfig[]>([])
  const [taskSlots, setTaskSlots] = useState<string[]>([])
  const [defaults, setDefaults] = useState<Defaults>({})
  const [providers, setProviders] = useState<ProviderInfo[]>([])

  useEffect(() => {
    fetch('/api/cms/model-config')
      .then(r => r.ok ? r.json() : Promise.reject('Failed to load'))
      .then(data => {
        setTaskSlots(data.taskSlots)
        setDefaults(data.defaults)
        setProviders(data.providers || [])
        setRoutingEnabled(data.config.routingEnabled || data.config.openRouterEnabled || false)

        const existingSlots = new Map<string, SlotConfig>()
        for (const s of data.config.slots || []) {
          existingSlots.set(s.taskSlot, {
            taskSlot: s.taskSlot,
            model: s.model,
            provider: s.provider || 'anthropic',
            fallbackModel: s.fallbackModel || '',
            fallbackProvider: s.fallbackProvider || 'anthropic',
            maxTokens: s.maxTokens,
            temperature: s.temperature,
            isActive: s.isActive,
            useToonInput: s.useToonInput || false,
          })
        }

        const fullSlots: SlotConfig[] = data.taskSlots.map((ts: string) => {
          const existing = existingSlots.get(ts)
          const def = data.defaults[ts]
          return existing || {
            taskSlot: ts,
            model: def?.model || '',
            provider: 'anthropic',
            fallbackModel: '',
            fallbackProvider: 'anthropic',
            maxTokens: def?.maxTokens || 1000,
            temperature: undefined,
            isActive: false,
            useToonInput: false,
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
      const payload = {
        routingEnabled,
        slots: slots.filter(s => s.isActive).map(s => ({
          taskSlot: s.taskSlot,
          model: s.model,
          provider: s.provider,
          fallbackModel: s.fallbackModel || undefined,
          fallbackProvider: s.fallbackProvider || undefined,
          maxTokens: s.maxTokens,
          temperature: s.temperature ?? undefined,
          isActive: true,
          useToonInput: s.useToonInput,
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

  const categories = new Map<string, SlotConfig[]>()
  for (const s of slots) {
    const cat = s.taskSlot.split('.')[0]
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push(s)
  }

  const configuredProviders = providers.filter(p => p.configured)
  const unconfiguredProviders = providers.filter(p => !p.configured)

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
          <p className="font-medium text-[#0f1419]">Model Routing</p>
          <p className="text-sm text-[#536471]">
            When enabled, active slots route through their configured provider. When disabled, all calls use Anthropic defaults.
          </p>
        </div>
        <button
          onClick={() => setRoutingEnabled(!routingEnabled)}
          className={`relative w-12 h-6 rounded-full transition-colors ${routingEnabled ? 'bg-[#2563eb]' : 'bg-[#cfd9de]'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${routingEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* Provider status */}
      <div className="bg-white border border-[#e1e8ed] rounded-xl p-5">
        <p className="font-medium text-[#0f1419] mb-3">Available Providers</p>
        <div className="flex flex-wrap gap-2">
          {configuredProviders.map(p => (
            <span key={p.name} className="px-3 py-1 bg-green-50 text-green-700 border border-green-200 rounded-full text-xs font-medium">
              {p.label}
            </span>
          ))}
          {unconfiguredProviders.map(p => (
            <span key={p.name} className="px-3 py-1 bg-[#f7f9f9] text-[#71767b] border border-[#e1e8ed] rounded-full text-xs">
              {p.label} (no API key)
            </span>
          ))}
        </div>
        {unconfiguredProviders.length > 0 && (
          <p className="text-xs text-[#71767b] mt-2">
            Set environment variables to enable more providers: {unconfiguredProviders.map(p => {
              const envMap: Record<string, string> = {
                anthropic: 'ANTHROPIC_API_KEY',
                openai: 'OPENAI_API_KEY',
                openrouter: 'OPENROUTER_API_KEY',
                google: 'GOOGLE_AI_API_KEY',
                groq: 'GROQ_API_KEY',
              }
              return envMap[p.name] || `${p.name.toUpperCase()}_API_KEY`
            }).join(', ')}
          </p>
        )}
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
                        Default: {def?.provider} / {def?.model} ({def?.maxTokens} tokens)
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
                    <div className="space-y-3">
                      {/* Primary config */}
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs text-[#71767b] mb-1">Provider</label>
                          <select
                            value={slot.provider}
                            onChange={e => updateSlot(idx, 'provider', e.target.value)}
                            className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                          >
                            {providers.map(p => (
                              <option key={p.name} value={p.name} disabled={!p.configured}>
                                {p.label}{!p.configured ? ' (no key)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-[#71767b] mb-1">Model</label>
                          <input
                            type="text"
                            value={slot.model}
                            onChange={e => updateSlot(idx, 'model', e.target.value)}
                            placeholder="e.g. gpt-4.1-mini"
                            className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                          />
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
                          <label className="block text-xs text-[#71767b] mb-1">Temperature</label>
                          <input
                            type="number"
                            step="0.1"
                            value={slot.temperature ?? ''}
                            onChange={e => updateSlot(idx, 'temperature', e.target.value ? parseFloat(e.target.value) : undefined)}
                            placeholder="Default"
                            className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                          />
                        </div>
                      </div>

                      {/* Fallback config */}
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs text-[#71767b] mb-1">Fallback Provider</label>
                          <select
                            value={slot.fallbackProvider}
                            onChange={e => updateSlot(idx, 'fallbackProvider', e.target.value)}
                            className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                          >
                            {providers.map(p => (
                              <option key={p.name} value={p.name} disabled={!p.configured}>
                                {p.label}{!p.configured ? ' (no key)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-[#71767b] mb-1">Fallback Model</label>
                          <input
                            type="text"
                            value={slot.fallbackModel}
                            onChange={e => updateSlot(idx, 'fallbackModel', e.target.value)}
                            placeholder="e.g. claude-haiku-4-5-20251001"
                            className="w-full px-3 py-2 border border-[#cfd9de] rounded-lg text-sm focus:outline-none focus:border-[#2563eb]"
                          />
                        </div>
                        <div className="flex items-center gap-2 pt-5">
                          <input
                            type="checkbox"
                            id={`toon-${slot.taskSlot}`}
                            checked={slot.useToonInput}
                            onChange={e => updateSlot(idx, 'useToonInput', e.target.checked)}
                            className="w-4 h-4 rounded border-[#cfd9de]"
                          />
                          <label htmlFor={`toon-${slot.taskSlot}`} className="text-xs text-[#71767b] cursor-pointer">
                            TOON input encoding
                          </label>
                        </div>
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
