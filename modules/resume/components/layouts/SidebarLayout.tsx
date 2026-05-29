import type { ResumeData } from '../../validators/resume'
import type { SidebarVariantId } from '../../config/sidebarThemes'
import { getSidebarTheme } from '../../config/sidebarThemes'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: SidebarVariantId
}

export default function SidebarLayout({ data, variantId }: Props) {
  const theme = getSidebarTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const mainTitle = theme.mainSectionTitleClass

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      {/* Paginated as one atomic block — sidebar + main advance together */}
      <div className="flex" data-resume-section="body" data-resume-columns>
        <div className={`${theme.sidebarWidth} ${theme.sidebarBg} p-3 min-h-full`}>
          <div className="mb-4" data-resume-section="contact">
            <h2 data-resume-section-header="Contact" className={theme.sidebarHeaderClass}>
              Contact
            </h2>
            {contact.email && <div className={theme.sidebarItemClass}>{contact.email}</div>}
            {contact.phone && <div className={theme.sidebarItemClass}>{contact.phone}</div>}
            {contact.location && <div className={theme.sidebarItemClass}>{contact.location}</div>}
            {contact.linkedin && <div className={theme.sidebarItemClass}>{contact.linkedin}</div>}
            {contact.website && <div className={theme.sidebarItemClass}>{contact.website}</div>}
            {contact.github && <div className={theme.sidebarItemClass}>{contact.github}</div>}
          </div>

          {data.skills && data.skills.length > 0 && (
            <ResumeSkillsSection
              skills={data.skills}
              title="Skills"
              sectionClassName="mb-4"
              headerClassName={theme.sidebarHeaderClass}
              renderCategory={(cat) => (
                <div className="mb-1.5">
                  <div className="text-[8px] font-semibold">{cat.category}</div>
                  {cat.items.map((item, j) => (
                    <div key={j} className={`text-[8px] ${theme.sidebarMutedClass}`}>
                      {item}
                    </div>
                  ))}
                </div>
              )}
            />
          )}

          {data.certifications && data.certifications.length > 0 && (
            <div className="mb-4" data-resume-section="certifications">
              <h2 data-resume-section-header="Certifications" className={theme.sidebarHeaderClass}>
                Certifications
              </h2>
              {data.certifications.map((cert, i) => (
                <div key={i} className="text-[8px] mb-1" data-resume-section-unit>
                  <div className="font-semibold">{cert.name}</div>
                  <div className={theme.sidebarMutedClass}>{cert.issuer}</div>
                  {cert.date && <div className={theme.sidebarFaintClass}>{cert.date}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={`${theme.mainWidth} p-3`}>
          <div className="mb-3">
            <h1
              className={`font-bold ${theme.accentClass} tracking-wide`}
              style={{ fontSize: 'var(--r-title, 18px)' }}
            >
              {contact.fullName || 'Your Name'}
            </h1>
          </div>

          {data.summary && (
            <div className="mb-3" data-resume-section="summary">
              <h2 data-resume-section-header={theme.summaryTitle} className={mainTitle}>
                {theme.summaryTitle}
              </h2>
              <p className="text-gray-700 leading-relaxed">{data.summary}</p>
            </div>
          )}

          {data.experience && data.experience.length > 0 && (
            <div className="mb-3" data-resume-section="experience">
              <h2 data-resume-section-header="Experience" className={mainTitle}>
                Experience
              </h2>
              {data.experience.map(exp => (
                <div key={exp.id} className="mb-2" data-resume-section-unit>
                  <div className="flex justify-between items-baseline">
                    <div>
                      <span className="font-bold">{exp.title}</span>
                      {exp.company && (
                        <span className={theme.accentClass}>
                          {theme.companyJoiner === 'pipe' ? ` | ${exp.company}` : ` @ ${exp.company}`}
                        </span>
                      )}
                    </div>
                    <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                      {exp.startDate} - {exp.endDate || 'Present'}
                    </span>
                  </div>
                  {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
                  {exp.bullets.filter(b => b.trim()).length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                        <li key={i} className="text-gray-700 flex items-start gap-1">
                          <span
                            className={`shrink-0 mt-[3px] w-1 h-1 rounded-full ${theme.bulletDotClass}`}
                          />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {data.projects && data.projects.length > 0 && (
            <div className="mb-3" data-resume-section="projects">
              <h2 data-resume-section-header="Projects" className={mainTitle}>
                Projects
              </h2>
              {data.projects.map(proj => (
                <div key={proj.id} className="mb-1.5" data-resume-section-unit>
                  <span className="font-bold">{proj.name}</span>
                  {proj.url && <span className={theme.projectUrlClass}>{proj.url}</span>}
                  {proj.technologies?.length ? (
                    <span className="text-[8px] text-gray-500">
                      {' '}
                      ({proj.technologies.join(', ')})
                    </span>
                  ) : null}
                  <p className="text-gray-700">{proj.description}</p>
                </div>
              ))}
            </div>
          )}

          {data.education && data.education.length > 0 && (
            <div className="mb-3" data-resume-section="education">
              <h2 data-resume-section-header="Education" className={mainTitle}>
                Education
              </h2>
              {data.education.map(edu => (
                <div key={edu.id} className="mb-1.5" data-resume-section-unit>
                  <div className="flex justify-between items-baseline">
                    <div>
                      <span className="font-bold">{edu.degree}</span>
                      {edu.field && <span> in {edu.field}</span>}
                      {edu.institution && <span> — {edu.institution}</span>}
                    </div>
                    {edu.graduationDate && (
                      <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                        {edu.graduationDate}
                      </span>
                    )}
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

          {data.customSections?.map(section => (
            <div key={section.id} className="mb-3" data-resume-section={`custom-${section.id}`}>
              <h2 data-resume-section-header={section.title} className={mainTitle}>
                {section.title}
              </h2>
              <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
            </div>
          ))}
        </div>
      </div>
    </TemplateRoot>
  )
}
