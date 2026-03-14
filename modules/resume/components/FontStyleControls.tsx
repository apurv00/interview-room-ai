'use client'

import { FONT_FAMILIES, FONT_SIZES } from '../config/fontConfig'

interface Props {
  fontFamily: string
  fontSize: string
  onFontFamilyChange: (id: string) => void
  onFontSizeChange: (size: string) => void
}

const SIZE_LABELS: Record<string, string> = { small: 'S', medium: 'M', large: 'L' }

export default function FontStyleControls({ fontFamily, fontSize, onFontFamilyChange, onFontSizeChange }: Props) {
  return (
    <div className="flex items-end gap-4">
      <div className="flex-1">
        <label className="text-[10px] text-slate-500 uppercase tracking-wider">Font</label>
        <select
          value={fontFamily}
          onChange={e => onFontFamilyChange(e.target.value)}
          className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 appearance-none cursor-pointer"
        >
          {FONT_FAMILIES.map(f => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] text-slate-500 uppercase tracking-wider">Size</label>
        <div className="flex gap-1 mt-1">
          {Object.keys(FONT_SIZES).map(size => (
            <button
              key={size}
              onClick={() => onFontSizeChange(size)}
              className={`px-3 py-2 rounded-lg text-[10px] font-medium transition-colors ${
                fontSize === size
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {SIZE_LABELS[size]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
