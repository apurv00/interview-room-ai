import type { TemplateProps } from './index'

export default function ExecutiveTemplate({ data }: TemplateProps) {
  const contact = data.contactInfo || { fullName: '', email: '' }

  return (
    <div className="text-gray-900 leading-snug" style={{ fontSize: 'var(--r-body, 9px)' }}>
      {/* Header */}
      <div className="text-center mb-3">
        <h1 className="font-bold tracking-widest uppercase text-[#1e293b]" style={{ fontSize: 'var(--r-title, 20px)' }}>{contact.fullName || 'Your Name'}</h1>
        <hr className="my-1.5 border-t border-[#1e293b]" />
        <div className="flex items-center justify-center gap-2 text-[8px] text-gray-600 flex-wrap">
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && <><span>|</span><span>{contact.phone}</span></>}
          {contact.location && <><span>|</span><span>{contact.location}</span></>}
          {contact.linkedin && <><span>|</span><span>{contact.linkedin}</span></>}
          {contact.website && <><span>|</span><span>{contact.website}</span></>}
          {contact.github && <><span>|</span><span>{contact.github}</span></>}
        </div>
      </div>

      {/* Executive Summary */}
      {data.summary && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Executive Summary</h2>
          <p className="text-gray-700 leading-relaxed italic">{data.summary}</p>
        </div>
      )}

      {/* Key Achievements & Experience */}
      {data.experience && data.experience.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Key Achievements &amp; Experience</h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-2">
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold uppercase">{exp.title}</span>
                  {exp.company && <span> — {exp.company}</span>}
                </div>
                <span className="text-[8px] text-gray-500 shrink-0 ml-2">{exp.startDate} - {exp.endDate || 'Present'}</span>
              </div>
              {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li key={i} className="text-gray-700 flex items-start gap-1">
                      <span className="shrink-0 mt-[2px] text-[#1e293b] font-bold text-[7px]">&#9654;</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Education */}
      {data.education && data.education.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Education</h2>
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

      {/* Skills */}
      {data.skills && data.skills.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Core Competencies</h2>
          <div className="grid grid-cols-3 gap-x-4 gap-y-0.5">
            {data.skills.map((cat, i) => (
              <div key={i}>
                <span className="font-semibold">{cat.category}:</span>{' '}
                <span className="text-gray-700">{cat.items.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Projects */}
      {data.projects && data.projects.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Notable Projects</h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1.5">
              <span className="font-bold">{proj.name}</span>
              {proj.technologies?.length ? <span className="text-[8px] text-gray-500"> ({proj.technologies.join(', ')})</span> : null}
              <p className="text-gray-700">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* Certifications */}
      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">Certifications &amp; Credentials</h2>
          {data.certifications.map((cert, i) => (
            <div key={i} className="mb-0.5">
              <span className="font-semibold">{cert.name}</span> — {cert.issuer}
              {cert.date && <span className="text-gray-500"> ({cert.date})</span>}
            </div>
          ))}
        </div>
      )}

      {/* Custom Sections */}
      {data.customSections?.map(section => (
        <div key={section.id} className="mb-3">
          <h2 className="font-bold uppercase tracking-[0.2em] text-[#1e293b] border-b-2 border-[#1e293b] pb-0.5 mb-1">{section.title}</h2>
          <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
        </div>
      ))}
    </div>
  )
}
