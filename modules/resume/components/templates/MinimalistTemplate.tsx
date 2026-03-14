import type { TemplateProps } from './index'

export default function MinimalistTemplate({ data }: TemplateProps) {
  const contact = data.contactInfo || { fullName: '', email: '' }

  return (
    <div className="font-sans text-gray-900 leading-relaxed" style={{ fontSize: '10px' }}>
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-lg font-light tracking-wide">{contact.fullName || 'Your Name'}</h1>
        <div className="flex items-center gap-3 text-[8px] text-gray-500 mt-1 flex-wrap">
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && <span>{contact.phone}</span>}
          {contact.location && <span>{contact.location}</span>}
          {contact.linkedin && <span>{contact.linkedin}</span>}
          {contact.website && <span>{contact.website}</span>}
          {contact.github && <span>{contact.github}</span>}
        </div>
        <hr className="mt-2 border-t border-gray-200" />
      </div>

      {/* Summary */}
      {data.summary && (
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Summary</h2>
          <p className="text-[9px] text-gray-600 leading-relaxed">{data.summary}</p>
        </div>
      )}

      {/* Experience */}
      {data.experience && data.experience.length > 0 && (
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Experience</h2>
          <hr className="border-t border-gray-100 mb-2" />
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-3">
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-medium text-[9px]">{exp.title}</span>
                  {exp.company && <span className="text-[9px] text-gray-500"> at {exp.company}</span>}
                </div>
                <span className="text-[8px] text-gray-400 shrink-0 ml-2">{exp.startDate} - {exp.endDate || 'Present'}</span>
              </div>
              {exp.location && <div className="text-[8px] text-gray-400">{exp.location}</div>}
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-1 space-y-1">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li key={i} className="text-[9px] text-gray-600 pl-3 relative">
                      <span className="absolute left-0 top-0">-</span>
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
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Education</h2>
          <hr className="border-t border-gray-100 mb-2" />
          {data.education.map(edu => (
            <div key={edu.id} className="mb-2">
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-medium text-[9px]">{edu.degree}</span>
                  {edu.field && <span className="text-[9px] text-gray-500"> in {edu.field}</span>}
                  {edu.institution && <span className="text-[9px] text-gray-500"> — {edu.institution}</span>}
                </div>
                {edu.graduationDate && <span className="text-[8px] text-gray-400 shrink-0 ml-2">{edu.graduationDate}</span>}
              </div>
              {(edu.gpa || edu.honors) && (
                <div className="text-[8px] text-gray-400 mt-0.5">
                  {edu.gpa && <span>GPA: {edu.gpa}</span>}
                  {edu.gpa && edu.honors && <span> · </span>}
                  {edu.honors && <span>{edu.honors}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {data.skills && data.skills.length > 0 && (
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Skills</h2>
          <hr className="border-t border-gray-100 mb-2" />
          {data.skills.map((cat, i) => (
            <div key={i} className="text-[9px] mb-1">
              <span className="font-medium">{cat.category}</span>
              <span className="text-gray-500 ml-2">{cat.items.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Projects */}
      {data.projects && data.projects.length > 0 && (
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Projects</h2>
          <hr className="border-t border-gray-100 mb-2" />
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-2">
              <span className="font-medium text-[9px]">{proj.name}</span>
              {proj.technologies?.length ? <span className="text-[8px] text-gray-400 ml-1">{proj.technologies.join(', ')}</span> : null}
              <p className="text-[9px] text-gray-600">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* Certifications */}
      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">Certifications</h2>
          <hr className="border-t border-gray-100 mb-2" />
          {data.certifications.map((cert, i) => (
            <div key={i} className="text-[9px] mb-1">
              <span className="font-medium">{cert.name}</span>
              <span className="text-gray-500"> — {cert.issuer}</span>
              {cert.date && <span className="text-gray-400"> ({cert.date})</span>}
            </div>
          ))}
        </div>
      )}

      {/* Custom Sections */}
      {data.customSections?.map(section => (
        <div key={section.id} className="mb-4">
          <h2 className="text-[9px] font-medium uppercase tracking-widest text-gray-400 mb-1.5">{section.title}</h2>
          <hr className="border-t border-gray-100 mb-2" />
          <p className="text-[9px] text-gray-600 whitespace-pre-wrap">{section.content}</p>
        </div>
      ))}
    </div>
  )
}
