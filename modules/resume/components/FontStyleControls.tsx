'use client'

import { FONT_FAMILIES, DEFAULT_HEADING_SIZE, DEFAULT_BODY_SIZE } from '../config/fontConfig'

interface Props {
  fontFamily: string
  headingSize: number
  bodySize: number
  onFontFamilyChange: (id: string) => void
  onHeadingSizeChange: (size: number) => void
  onBodySizeChange: (size: number) => void
}

export default function FontStyleControls({ fontFamily, headingSize, bodySize, onFontFamilyChange, onHeadingSizeChange, onBodySizeChange }: Props) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-[10px] text-slate-500 uppercase tracking-wider">Font</label>
        <select
          value={fontFamily}
          onChange={e => onFontFamilyChange(e.target.value)}
          className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] focus:outline-none focus:ring-2 focus:ring-emerald-500 appearance-none cursor-pointer"
        >
          {FONT_FAMILIES.map(f => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Heading Size</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="range"
              min={12}
              max={28}
              step={1}
              value={headingSize}
              onChange={e => onHeadingSizeChange(Number(e.target.value))}
              className="flex-1 accent-emerald-500 h-1.5"
            />
            <input
              type="number"
              min={12}
              max={28}
              value={headingSize}
              onChange={e => {
                const v = Number(e.target.value)
                if (v >= 12 && v <= 28) onHeadingSizeChange(v)
              }}
              className="w-12 px-1.5 py-1 bg-white border border-[#e1e8ed] rounded text-xs text-[#0f1419] text-center focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Body Size</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="range"
              min={7}
              max={14}
              step={0.5}
              value={bodySize}
              onChange={e => onBodySizeChange(Number(e.target.value))}
              className="flex-1 accent-emerald-500 h-1.5"
            />
            <input
              type="number"
              min={7}
              max={14}
              step={0.5}
              value={bodySize}
              onChange={e => {
                const v = Number(e.target.value)
                if (v >= 7 && v <= 14) onBodySizeChange(v)
              }}
              className="w-12 px-1.5 py-1 bg-white border border-[#e1e8ed] rounded text-xs text-[#0f1419] text-center focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => { onHeadingSizeChange(DEFAULT_HEADING_SIZE); onBodySizeChange(DEFAULT_BODY_SIZE) }}
          className="text-[10px] text-[#536471] hover:text-[#0f1419] transition-colors"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  )
}
