import type { ResumeContactInfo } from '../../validators/resume'

interface Props {
  data: ResumeContactInfo
  onChange: (info: Partial<ResumeContactInfo>) => void
}

const FIELDS: Array<{ key: keyof ResumeContactInfo; label: string; placeholder: string; required?: boolean }> = [
  { key: 'fullName', label: 'Full Name', placeholder: 'John Doe', required: true },
  { key: 'email', label: 'Email', placeholder: 'john@example.com', required: true },
  { key: 'phone', label: 'Phone', placeholder: '+1 (555) 123-4567' },
  { key: 'location', label: 'Location', placeholder: 'San Francisco, CA' },
  { key: 'linkedin', label: 'LinkedIn', placeholder: 'linkedin.com/in/johndoe' },
  { key: 'website', label: 'Website', placeholder: 'johndoe.com' },
  { key: 'github', label: 'GitHub', placeholder: 'github.com/johndoe' },
]

export default function ContactInfoEditor({ data, onChange }: Props) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Contact Information</h3>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(f => (
          <div key={f.key} className={f.key === 'fullName' ? 'col-span-2' : ''}>
            <label className="text-[10px] text-slate-400 uppercase tracking-wider">{f.label}</label>
            <input
              type="text"
              value={data[f.key] || ''}
              onChange={e => onChange({ [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
