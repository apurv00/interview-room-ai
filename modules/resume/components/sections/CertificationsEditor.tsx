import type { ResumeCertification } from '../../validators/resume'

interface Props {
  items: ResumeCertification[]
  onChange: (certs: ResumeCertification[]) => void
}

export default function CertificationsEditor({ items, onChange }: Props) {
  function addNew() {
    onChange([...items, { name: '', issuer: '' }])
  }

  function update(idx: number, data: Partial<ResumeCertification>) {
    const updated = [...items]
    updated[idx] = { ...updated[idx], ...data }
    onChange(updated)
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#0f1419]">Certifications</h3>
        <button onClick={addNew} className="px-2.5 py-1 bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] text-[10px] rounded-lg font-medium transition-colors">
          + Add Certification
        </button>
      </div>

      {items.map((cert, idx) => (
        <div key={idx} className="border border-[#e1e8ed] rounded-xl p-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">Name</label>
              <input type="text" value={cert.name} onChange={e => update(idx, { name: e.target.value })} placeholder="AWS Solutions Architect" className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">Issuer</label>
              <input type="text" value={cert.issuer} onChange={e => update(idx, { issuer: e.target.value })} placeholder="Amazon Web Services" className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">Date</label>
                <input type="text" value={cert.date || ''} onChange={e => update(idx, { date: e.target.value })} placeholder="2024" className="w-full mt-1 px-3 py-2 bg-white border border-[#e1e8ed] rounded-lg text-sm text-[#0f1419] placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>
              <button onClick={() => remove(idx)} className="self-end mb-1 text-slate-500 hover:text-red-400 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
        </div>
      ))}

      {items.length === 0 && <p className="text-xs text-slate-500 text-center py-4">No certifications added yet.</p>}
    </div>
  )
}
