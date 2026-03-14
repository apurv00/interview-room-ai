import type { TemplateProps } from './index'

export default function CreativeTemplate({ data }: TemplateProps) {
  const contact = data.contactInfo || { fullName: '', email: '' }

  return (
    <div className="text-gray-900 leading-snug" style={{ fontSize: 'var(--r-body, 9px)' }}>
      <div className="flex">
        {/* Left Sidebar */}
        <div className="w-[20%] bg-[#6366f1] text-white p-3 min-h-full">
          {/* Contact */}
          <div className="mb-4">
            <h2 className="font-bold uppercase tracking-widest border-b border-white/30 pb-0.5 mb-1">Contact</h2>
            {contact.email && <div className="text-[8px] mb-0.5">{contact.email}</div>}
            {contact.phone && <div className="text-[8px] mb-0.5">{contact.phone}</div>}
            {contact.location && <div className="text-[8px] mb-0.5">{contact.location}</div>}
            {contact.linkedin && <div className="text-[8px] mb-0.5">{contact.linkedin}</div>}
            {contact.website && <div className="text-[8px] mb-0.5">{contact.website}</div>}
            {contact.github && <div className="text-[8px] mb-0.5">{contact.github}</div>}
          </div>

          {/* Skills */}
          {data.skills && data.skills.length > 0 && (
            <div className="mb-4">
              <h2 className="font-bold uppercase tracking-widest border-b border-white/30 pb-0.5 mb-1">Skills</h2>
              {data.skills.map((cat, i) => (
                <div key={i} className="mb-1.5">
                  <div className="text-[8px] font-semibold">{cat.category}</div>
                  {cat.items.map((item, j) => (
                    <div key={j} className="text-[8px] text-white/80">{item}</div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Certifications */}
          {data.certifications && data.certifications.length > 0 && (
            <div className="mb-4">
              <h2 className="font-bold uppercase tracking-widest border-b border-white/30 pb-0.5 mb-1">Certifications</h2>
              {data.certifications.map((cert, i) => (
                <div key={i} className="text-[8px] mb-1">
                  <div className="font-semibold">{cert.name}</div>
                  <div className="text-white/80">{cert.issuer}</div>
                  {cert.date && <div className="text-white/60">{cert.date}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Main Area */}
        <div className="w-[80%] p-3">
          {/* Header */}
          <div className="mb-3">
            <h1 className="font-bold text-[#6366f1] tracking-wide" style={{ fontSize: 'var(--r-title, 18px)' }}>{contact.fullName || 'Your Name'}</h1>
          </div>

          {/* Summary */}
          {data.summary && (
            <div className="mb-3">
              <h2 className="font-bold uppercase tracking-widest text-[#6366f1] border-b border-gray-200 pb-0.5 mb-1">About Me</h2>
              <p className="text-gray-700 leading-relaxed">{data.summary}</p>
            </div>
          )}

          {/* Experience */}
          {data.experience && data.experience.length > 0 && (
            <div className="mb-3">
              <h2 className="font-bold uppercase tracking-widest text-[#6366f1] border-b border-gray-200 pb-0.5 mb-1">Experience</h2>
              {data.experience.map(exp => (
                <div key={exp.id} className="mb-2">
                  <div className="flex justify-between items-baseline">
                    <div>
                      <span className="font-bold">{exp.title}</span>
                      {exp.company && <span className="text-[#6366f1]"> | {exp.company}</span>}
                    </div>
                    <span className="text-[8px] text-gray-500 shrink-0 ml-2">{exp.startDate} - {exp.endDate || 'Present'}</span>
                  </div>
                  {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
                  {exp.bullets.filter(b => b.trim()).length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                        <li key={i} className="text-gray-700 flex items-start gap-1">
                          <span className="shrink-0 mt-[3px] w-1 h-1 bg-[#6366f1] rounded-full" />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Projects */}
          {data.projects && data.projects.length > 0 && (
            <div className="mb-3">
              <h2 className="font-bold uppercase tracking-widest text-[#6366f1] border-b border-gray-200 pb-0.5 mb-1">Projects</h2>
              {data.projects.map(proj => (
                <div key={proj.id} className="mb-1.5">
                  <span className="font-bold">{proj.name}</span>
                  {proj.url && <span className="text-[8px] text-[#6366f1] ml-1">{proj.url}</span>}
                  {proj.technologies?.length ? <span className="text-[8px] text-gray-500"> ({proj.technologies.join(', ')})</span> : null}
                  <p className="text-gray-700">{proj.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Education */}
          {data.education && data.education.length > 0 && (
            <div className="mb-3">
              <h2 className="font-bold uppercase tracking-widest text-[#6366f1] border-b border-gray-200 pb-0.5 mb-1">Education</h2>
              {data.education.map(edu => (
                <div key={edu.id} className="mb-1.5">
                  <div className="flex justify-between items-baseline">
                    <div>
                      <span className="font-bold">{edu.degree}</span>
                      {edu.field && <span> in {edu.field}</span>}
                      {edu.institution && <span> — {edu.institution}</span>}
                    </div>
                    {edu.graduationDate && <span className="text-[8px] text-gray-500 shrink-0 ml-2">{edu.graduationDate}</span>}
                  </div>
                  {(edu.gpa || edu.honors) && (
                    <div className="text-[8px] text-gray-500">
                      {edu.gpa && <span>GPA: {edu.gpa}</span>}
                      {edu.gpa && edu.honors && <span> | </span>}
                      {edu.honors && <span>{edu.honors}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Custom Sections */}
          {data.customSections?.map(section => (
            <div key={section.id} className="mb-3">
              <h2 className="font-bold uppercase tracking-widest text-[#6366f1] border-b border-gray-200 pb-0.5 mb-1">{section.title}</h2>
              <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
