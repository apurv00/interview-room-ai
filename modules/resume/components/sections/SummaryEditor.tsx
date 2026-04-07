interface Props {
  value: string
  onChange: (value: string) => void
  onEnhance?: () => void
  enhancing?: boolean
}

export default function SummaryEditor({ value, onChange, onEnhance, enhancing }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Professional Summary</h3>
        {onEnhance && (
          <button
            onClick={onEnhance}
            disabled={enhancing || !value.trim()}
            className="px-2.5 py-1 bg-emerald-600/10 border border-emerald-500/20 text-[#059669] text-[10px] rounded-lg font-medium transition-colors hover:bg-emerald-600/20 disabled:opacity-30"
          >
            {enhancing ? 'Enhancing...' : 'AI Enhance'}
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="A brief 2-3 sentence professional summary highlighting your key strengths and career objectives..."
        rows={4}
        className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
      />
    </div>
  )
}
