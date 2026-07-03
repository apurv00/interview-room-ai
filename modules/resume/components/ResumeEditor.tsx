'use client'

import { useState, useEffect, useRef } from 'react'
import type { ResumeData } from '../validators/resume'
import { useResume } from '../hooks/useResume'
import { buildUploadPrefill } from '../lib/parseSalvage'
import { getTemplateSectionOrder, templateHonorsSectionOrder } from '../config/sectionOrders'
import { RESUME_TEMPLATES } from '../config/templates'
import { TEMPLATE_FAMILIES, TEMPLATE_VARIANTS } from '../config/templateFamilies'
import ResumePreview from './ResumePreview'
import ContactInfoEditor from './sections/ContactInfoEditor'
import SummaryEditor from './sections/SummaryEditor'
import ExperienceEditor from './sections/ExperienceEditor'
import EducationEditor from './sections/EducationEditor'
import SkillsEditor from './sections/SkillsEditor'
import ProjectsEditor from './sections/ProjectsEditor'
import CertificationsEditor from './sections/CertificationsEditor'
import CustomSectionEditor from './sections/CustomSectionEditor'
import FileDropzone from '@shared/ui/FileDropzone'
import FontStyleControls from './FontStyleControls'
import SortableList from './SortableList'
import SortableItem, { DragHandle } from './SortableItem'
import AnonymousDraftBanner from './AnonymousDraftBanner'
import { useAuthGate } from '@shared/providers/AuthGateProvider'
import { track } from '@shared/analytics/track'

interface Props {
  initialData?: Partial<ResumeData>
  resumeId?: string
  onSave: (data: ResumeData) => Promise<{ id?: string; error?: string; code?: string; clamped?: boolean }>
  /** When true, AI/save/download actions are gated behind the auth modal
   *  and edits are auto-persisted to localStorage via onAnonymousChange. */
  isAnonymous?: boolean
  onAnonymousChange?: (data: ResumeData) => void
  /** localStorage key for the SIGNED-IN unsaved-work draft (scoped to
   *  user + resume by the caller). Absent → no authed draft persistence. */
  draftKey?: string
  /** Start the editor dirty — for content the caller INJECTED as initialData
   *  and that is not yet saved (e.g. a claimed anonymous draft). Arms the
   *  unsaved-work nets immediately instead of only after a manual keystroke. */
  initialDirty?: boolean
}

export default function ResumeEditor({ initialData, resumeId, onSave, isAnonymous = false, onAnonymousChange, draftKey, initialDirty }: Props) {
  const { requireAuth } = useAuthGate()
  const {
    resume, isDirty, update, setContactInfo,
    addExperience, updateExperience, removeExperience,
    addEducation, updateEducation, removeEducation,
    setSkills,
    addProject, updateProject, removeProject,
    setCertifications,
    addCustomSection, updateCustomSection, removeCustomSection,
    reorderExperience, reorderEducation, reorderProjects, reorderCustomSections,
    reorderBullets, reorderSections,
    loadResume, markClean,
  } = useResume(initialData, { initialDirty })

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [enhancingSection, setEnhancingSection] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [mobileTab, setMobileTab] = useState<'edit' | 'preview'>('edit')
  const [downloading, setDownloading] = useState(false)
  /** One-level undo for the latest AI enhancement — the enhance buttons
   *  REPLACE user-written content in place, which was irreversible.
   *  `isCurrent` reports whether the AI-written content is still untouched;
   *  the effect below drops the undo the moment it isn't. */
  const [lastEnhance, setLastEnhance] = useState<{
    label: string
    undo: () => void
    isCurrent: (r: ResumeData) => boolean
  } | null>(null)
  const [showPasteImport, setShowPasteImport] = useState(false)
  const [pasteText, setPasteText] = useState('')
  /** Bumped whenever the resume is REPLACED wholesale (import/profile/restore).
   *  An AI-enhance request captures the value at send time; if it changed by the
   *  time the response lands, the response targets a resume that no longer
   *  exists in the editor — applying it would write the OLD resume's text into
   *  the replacement, so we discard it (Codex P3). */
  const resumeGenerationRef = useRef(0)
  /** Always-current resume snapshot for async callbacks (enhance responses):
   *  the component closure captures `resume` at render time and goes stale
   *  during an in-flight fetch, so reading it back after `await` would compare
   *  against the OLD value. */
  const resumeRef = useRef(resume)
  useEffect(() => { resumeRef.current = resume }, [resume])

  // A pending undo is only valid while the enhanced content is untouched:
  // once the user manually edits the AI-written field (or the resume is
  // replaced), restoring the pre-enhancement snapshot would erase those
  // later edits too (Codex P2).
  useEffect(() => {
    if (lastEnhance && !lastEnhance.isCurrent(resume)) setLastEnhance(null)
  }, [resume, lastEnhance])

  // Persist anonymous edits to localStorage so the user's work survives
  // page reloads and an OAuth round-trip.
  useEffect(() => {
    if (!isAnonymous || !onAnonymousChange) return
    onAnonymousChange(resume)
  }, [resume, isAnonymous, onAnonymousChange])

  // Signed-in users had ZERO unsaved-work protection — the anonymous flow was
  // ironically safer. Two nets: (1) a beforeunload prompt while dirty;
  // (2) a debounced localStorage draft (keyed by user+resume via draftKey)
  // with a restore banner on the next load. The draft clears on save.
  useEffect(() => {
    if (isAnonymous || !isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty, isAnonymous])

  const [restorableDraft, setRestorableDraft] = useState<{ data: Partial<ResumeData>; savedAt: string } | null>(null)

  useEffect(() => {
    if (isAnonymous || !draftKey) return
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) {
        const parsed = JSON.parse(raw) as { data: Partial<ResumeData>; savedAt: string }
        if (parsed?.data && parsed?.savedAt) setRestorableDraft(parsed)
      }
    } catch { /* corrupt draft — ignore */ }
    // Read once per key; writes below keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, isAnonymous])

  useEffect(() => {
    // Pause autosave while a restore banner is still OFFERING a prior-session
    // draft: writing the current near-empty state over it (one keystroke was
    // enough) destroyed the very draft the banner advertised. Resolving the
    // banner (Restore or Discard) clears restorableDraft and resumes autosave.
    if (isAnonymous || !draftKey || !isDirty || restorableDraft) return
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ data: resume, savedAt: new Date().toISOString() }))
      } catch { /* quota — draft is best-effort */ }
    }, 800)
    return () => clearTimeout(t)
  }, [resume, isDirty, isAnonymous, draftKey, restorableDraft])

  function clearDraft() {
    if (!draftKey) return
    try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
    setRestorableDraft(null)
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setNotice('')
    const result = await onSave({ ...resume, id: resumeId })
    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      markClean()
      clearDraft()
      // Don't let "Saved!" hide a silent truncation — the server clamps
      // over-long fields to their limits and the editor still shows the full
      // text until reload, so tell the user what will differ.
      if (result.clamped) {
        setNotice('Saved. Some entries were longer than the allowed limit and were shortened — reload to see the saved version.')
      }
      setTimeout(() => setSaved(false), 3000)
    }
    setSaving(false)
  }

  async function handleEnhanceSummary() {
    if (!resume.summary?.trim()) return
    if (isAnonymous) { requireAuth('enhance_resume'); return }
    const gen = resumeGenerationRef.current
    setEnhancingSection('summary')
    setError('')
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enhance',
          sectionType: 'summary',
          currentContent: resume.summary,
          targetRole: resume.targetRole,
          targetCompany: resume.targetCompany,
        }),
      })
      const data = await res.json()
      // The resume was replaced (import/profile/restore) while this was in
      // flight — applying now would write into a resume the user discarded.
      if (resumeGenerationRef.current !== gen) { setEnhancingSection(null); return }
      if (res.ok && data.enhanced) {
        const prev = resume.summary
        const enhanced = data.enhanced as string
        update('summary', enhanced)
        setLastEnhance({
          label: 'Summary enhanced by AI',
          undo: () => update('summary', prev),
          isCurrent: r => r.summary === enhanced,
        })
      } else {
        // Previously a failure did NOTHING — the user clicked, the spinner
        // stopped, and there was no way to tell it hadn't worked.
        setError(data.error || 'AI enhancement failed — your summary is unchanged. Try again.')
      }
    } catch { setError('AI enhancement failed — your summary is unchanged. Try again.') }
    setEnhancingSection(null)
  }

  async function handleEnhanceBullets(expId: string) {
    const exp = resume.experience?.find(e => e.id === expId)
    if (!exp || exp.bullets.every(b => !b.trim())) return
    if (isAnonymous) { requireAuth('enhance_resume'); return }
    const gen = resumeGenerationRef.current
    const sentBullets = JSON.stringify(exp.bullets)
    setEnhancingSection(expId)
    setError('')
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enhance_bullets',
          bullets: exp.bullets.filter(b => b.trim()),
          context: { role: exp.title, company: exp.company, targetRole: resume.targetRole },
        }),
      })
      const data = await res.json()
      // Discard if the resume was replaced, or the user edited these bullets
      // while the request was in flight (applying would clobber those edits).
      // Read the LIVE resume via ref — the closure's `resume` is stale here.
      const liveBullets = resumeRef.current.experience?.find(e => e.id === expId)?.bullets
      if (resumeGenerationRef.current !== gen || JSON.stringify(liveBullets) !== sentBullets) {
        setEnhancingSection(null)
        return
      }
      if (res.ok && data.bullets) {
        const prevBullets = exp.bullets
        const enhancedKey = JSON.stringify(data.bullets)
        updateExperience(expId, { bullets: data.bullets })
        setLastEnhance({
          label: `Bullets enhanced for ${exp.title || exp.company || 'this role'}`,
          undo: () => updateExperience(expId, { bullets: prevBullets }),
          isCurrent: r => JSON.stringify(r.experience?.find(e => e.id === expId)?.bullets) === enhancedKey,
        })
      } else {
        setError(data.error || 'AI enhancement failed — your bullets are unchanged. Try again.')
      }
    } catch { setError('AI enhancement failed — your bullets are unchanged. Try again.') }
    setEnhancingSection(null)
  }

  async function handleUpload(file: File) {
    if (isAnonymous) { requireAuth('parse_resume'); return }
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')
      const uploadRes = await fetch('/api/documents/upload', { method: 'POST', body: formData })
      const uploadData = await uploadRes.json()
      // The route now returns actionable messages (unsupported type: 415,
      // scanned/empty file: 422) — surface them verbatim.
      if (!uploadRes.ok) { setError(uploadData.error || 'Upload failed'); setUploading(false); return }

      await importFromText(uploadData.text)
    } catch { setError('Upload failed') }
    setUploading(false)
  }

  // Parse raw resume text into structured data and prefill the editor.
  // Shared by file upload and paste-to-import. Partial-tolerant contract:
  // whatever sections survived come back under `resume` — prefill ALL of
  // them (the old code discarded a perfect parse when contactInfo was
  // missing).
  async function importFromText(text: string) {
    const parseRes = await fetch('/api/resume/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const parsed = await parseRes.json()
    if (parseRes.ok && parsed.resume && parsed.importedSections?.length) {
      // Import = REPLACE: buildUploadPrefill wraps the (intentionally
      // partial) parse in explicit empties so sections absent from the
      // imported text don't survive as stale draft data in the merge.
      // markDirty: imported content is unsaved — arm beforeunload + autosave
      // so it survives a tab close during the "Review before saving" window.
      loadResume(buildUploadPrefill(parsed.resume) as Partial<ResumeData>, { markDirty: true })
      // The replacement invalidates any pending AI-enhance undo AND any
      // in-flight enhance response — both target the previous resume.
      resumeGenerationRef.current++
      setLastEnhance(null)
      const summary = `Imported ${parsed.importedSections.length === 1 ? '1 section' : `${parsed.importedSections.length} sections`}: ${parsed.importedSections.join(', ')}. Review before saving.`
      setNotice(parsed.warning ? `${summary} ${parsed.warning}` : summary)
      return true
    }
    if (parseRes.status === 429 && parsed.code === 'ANON_DAILY_LIMIT') {
      setError('Daily import limit reached. Sign in for unlimited imports.')
      requireAuth('parse_resume')
      return false
    }
    setError(parsed.error || 'Could not parse resume structure. Please fill in sections manually.')
    return false
  }

  async function handlePasteImport() {
    const text = pasteText.trim()
    if (text.length < 10) { setError('Paste at least a few lines of resume text first.'); return }
    // No auth gate: /api/resume/parse is authOptional with its own anonymous
    // daily cap — pasting is the anonymous-friendly import path (file upload
    // stays gated because /api/documents/upload requires auth).
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const ok = await importFromText(text)
      if (ok) { setShowPasteImport(false); setPasteText('') }
    } catch { setError('Import failed') }
    setUploading(false)
  }

  async function handleImportProfile() {
    if (isAnonymous) { requireAuth('save_resume'); return }
    try {
      const res = await fetch('/api/resume/profile')
      const data = await res.json()
      if (res.ok && data) {
        loadResume(data, { markDirty: true })
        // Same as importFromText: pending undo + in-flight enhance both target
        // the replaced resume — invalidate them.
        resumeGenerationRef.current++
        setLastEnhance(null)
      }
    } catch { /* ignore */ }
  }

  async function handleGenerateFull() {
    if (!resume.targetRole) return
    if (isAnonymous) { requireAuth('enhance_resume'); return }
    const gen = resumeGenerationRef.current
    setEnhancingSection('full')
    setError('')
    try {
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_full',
          targetRole: resume.targetRole,
          targetCompany: resume.targetCompany,
          currentSections: [
            { type: 'summary', content: resume.summary || '' },
            ...(resume.experience || []).map(e => ({ type: 'experience', content: `${e.title} at ${e.company}: ${e.bullets.join('. ')}` })),
          ],
        }),
      })
      const data = await res.json()
      if (resumeGenerationRef.current !== gen) { setEnhancingSection(null); return }
      const summarySection = res.ok
        ? (data.sections as Array<{ type: string; content?: string }> | undefined)?.find(s => s.type === 'summary' && s.content)
        : undefined
      if (summarySection?.content) {
        const prev = resume.summary || ''
        const generated = summarySection.content
        update('summary', generated)
        setLastEnhance({
          label: 'Summary generated by AI',
          undo: () => update('summary', prev),
          isCurrent: r => r.summary === generated,
        })
      } else {
        setError(data.error || 'AI generation failed — nothing was changed. Try again.')
      }
    } catch { setError('AI generation failed — nothing was changed. Try again.') }
    setEnhancingSection(null)
  }

  async function handlePrintPDF() {
    // Open a print window synchronously (inside the click handler) so the
    // browser doesn't treat the later programmatic open as a blocked popup.
    const printWindow = window.open('', '_blank')
    if (!printWindow) { setError('Pop-up blocked. Please allow pop-ups and try again.'); return }
    printWindow.document.write(
      '<!doctype html><title>Preparing…</title><body style="font:14px sans-serif;color:#475569;padding:32px">Preparing your resume…</body>',
    )

    try {
      // Fetch the SAME fully-styled, Tailwind-inlined, paginated HTML the server
      // PDF renderer uses — but with no Puppeteer/Chromium (so it can't hit the
      // serverless memory ceiling). The returned document auto-prints once its
      // pagination script has built the pages, so the output matches the
      // template for every format instead of the old unstyled DOM clone.
      const res = await fetch('/api/resume/pdf-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeData: resume,
          templateId: resume.template || 'professional',
        }),
      })
      if (!res.ok) throw new Error(`pdf-html ${res.status}`)
      const html = await res.text()
      printWindow.document.open()
      printWindow.document.write(html)
      printWindow.document.close()
    } catch {
      printWindow.close()
      setError('Could not prepare the resume for printing. Please try again.')
    }
  }

  async function handleDownloadPDF() {
    if (isAnonymous) { requireAuth('download_resume'); return }
    setDownloading(true)
    try {
      // Primary path: the server renders the same React template the preview
      // uses, inlines a pre-compiled Tailwind bundle, and runs puppeteer for a
      // one-click file download. If that fails (e.g. serverless Chromium), fall
      // back to the styled browser-print path, which produces the same layout.
      const res = await fetch('/api/resume/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeData: resume,
          templateId: resume.template || 'professional',
        }),
      })
      if (!res.ok) {
        await handlePrintPDF()
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${resume.name || 'resume'}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      track('resume_downloaded', {
        template: resume.template || 'professional',
        file_type: 'pdf',
      })
    } catch {
      await handlePrintPDF()
    } finally {
      // Always reset — the old early-return on the fallback path left the
      // button stuck on "Generating…" forever.
      setDownloading(false)
    }
  }

  const honorsSectionOrder = templateHonorsSectionOrder(resume.template || 'professional')
  // ?.length, not ||: saveResume persists `sectionOrder: []` for resumes never
  // reordered, and [] is truthy — `[] || default` rendered ZERO section editors.
  const allSectionIds = resume.sectionOrder?.length
    ? resume.sectionOrder
    : getTemplateSectionOrder(resume.template || 'professional')
  // Contact info renders as a fixed header in every template — the layouts'
  // resolveSectionOrder filters it out of the body order — so offering a drag
  // handle for it was a silent no-op. Pin it above the sortable list instead.
  const sectionIds = allSectionIds.filter(id => id !== 'contactInfo')

  function renderSectionEditor(sectionId: string) {
    return (
      <>
        {sectionId === 'contactInfo' && (
          <ContactInfoEditor
            data={resume.contactInfo || { fullName: '', email: '' }}
            onChange={setContactInfo}
          />
        )}
        {sectionId === 'summary' && (
          <SummaryEditor
            value={resume.summary || ''}
            onChange={v => update('summary', v)}
            onEnhance={handleEnhanceSummary}
            enhancing={enhancingSection === 'summary' || enhancingSection === 'full'}
          />
        )}
        {sectionId === 'experience' && (
          <ExperienceEditor
            items={resume.experience || []}
            onAdd={addExperience}
            onUpdate={updateExperience}
            onRemove={removeExperience}
            onEnhanceBullets={handleEnhanceBullets}
            enhancingId={enhancingSection}
            onReorder={reorderExperience}
            onReorderBullets={reorderBullets}
          />
        )}
        {sectionId === 'education' && (
          <EducationEditor
            items={resume.education || []}
            onAdd={addEducation}
            onUpdate={updateEducation}
            onRemove={removeEducation}
            onReorder={reorderEducation}
          />
        )}
        {sectionId === 'skills' && (
          <SkillsEditor
            items={resume.skills || []}
            onChange={setSkills}
          />
        )}
        {sectionId === 'projects' && (
          <ProjectsEditor
            items={resume.projects || []}
            onAdd={addProject}
            onUpdate={updateProject}
            onRemove={removeProject}
            onReorder={reorderProjects}
          />
        )}
        {sectionId === 'certifications' && (
          <CertificationsEditor
            items={resume.certifications || []}
            onChange={setCertifications}
          />
        )}
        {sectionId === 'customSections' && (
          <CustomSectionEditor
            items={resume.customSections || []}
            onAdd={addCustomSection}
            onUpdate={updateCustomSection}
            onRemove={removeCustomSection}
            onReorder={reorderCustomSections}
          />
        )}
      </>
    )
  }

  return (
    <div>
      <h1 className="sr-only">Resume Builder</h1>
      {isAnonymous && (
        <div className="mb-4">
          <AnonymousDraftBanner />
        </div>
      )}
      {/* Mobile tab toggle */}
      <div className="md:hidden flex border-b border-slate-200 mb-4">
        <button
          onClick={() => setMobileTab('edit')}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${mobileTab === 'edit' ? 'text-[#059669] border-b-2 border-[#059669]' : 'text-slate-500'}`}
        >Edit</button>
        <button
          onClick={() => setMobileTab('preview')}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${mobileTab === 'preview' ? 'text-[#059669] border-b-2 border-[#059669]' : 'text-slate-500'}`}
        >Preview</button>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Editor Panel - full width on mobile, 50% on desktop */}
        <div className={`w-full md:w-1/2 md:shrink-0 space-y-5 md:pr-2 ${mobileTab === 'preview' ? 'hidden md:block' : ''}`}>
          {/* Top bar: name, actions */}
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={resume.name}
              onChange={e => update('name', e.target.value)}
              className="text-xl font-bold text-slate-900 bg-transparent border-none focus:outline-none"
              placeholder="Resume Name"
              aria-label="Resume name"
            />
            <div className="flex gap-2">
              <button
                onClick={handlePrintPDF}
                className="px-3 py-1.5 bg-slate-100 border border-slate-200 text-slate-500 text-xs rounded-lg font-medium hover:bg-slate-200 transition-colors"
              >
                Print PDF
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={downloading}
                className="px-3 py-1.5 bg-blue-50 border border-blue-200 text-blue-600 text-xs rounded-lg font-medium hover:bg-blue-100 transition-colors disabled:opacity-50"
              >
                {downloading ? 'Generating...' : 'Download PDF'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : isDirty ? 'Save*' : 'Save'}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-600">
              {error}
            </div>
          )}

          {notice && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs text-emerald-700">
              {notice}
            </div>
          )}

          {lastEnhance && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-xs text-blue-700 flex items-center justify-between gap-3">
              <span>{lastEnhance.label}.</span>
              <span className="flex gap-2 shrink-0">
                <button
                  onClick={() => { lastEnhance.undo(); setLastEnhance(null) }}
                  className="px-2.5 py-1 bg-blue-600/10 border border-blue-500/30 rounded-lg font-medium hover:bg-blue-600/20 transition-colors"
                >
                  Undo
                </button>
                <button
                  onClick={() => setLastEnhance(null)}
                  aria-label="Keep AI change and dismiss"
                  className="px-2.5 py-1 border border-slate-300 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Keep
                </button>
              </span>
            </div>
          )}

          {restorableDraft && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-700 flex items-center justify-between gap-3">
              <span>
                You have unsaved edits from {new Date(restorableDraft.savedAt).toLocaleString()}. Restore them?
              </span>
              <span className="flex gap-2 shrink-0">
                <button
                  onClick={() => { loadResume(restorableDraft.data, { markDirty: true }); resumeGenerationRef.current++; setRestorableDraft(null); setLastEnhance(null) }}
                  className="px-2.5 py-1 bg-amber-600/10 border border-amber-500/30 rounded-lg font-medium hover:bg-amber-600/20 transition-colors"
                >
                  Restore
                </button>
                <button
                  onClick={clearDraft}
                  className="px-2.5 py-1 border border-slate-300 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors"
                >
                  Discard
                </button>
              </span>
            </div>
          )}

          {/* Upload / Import */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-500">Quick Start</h3>
              <button
                onClick={handleImportProfile}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 text-[10px] rounded-lg font-medium transition-colors"
              >
                Import from Profile
              </button>
            </div>
            <FileDropzone
              label="Upload Resume (PDF, DOCX, TXT)"
              isUploading={uploading}
              onFileSelect={handleUpload}
              onRemove={() => {}}
              onError={setError}
            />
            {!showPasteImport ? (
              <button
                onClick={() => setShowPasteImport(true)}
                className="text-[11px] text-blue-600 hover:underline"
              >
                Or paste resume text instead
              </button>
            ) : (
              <div className="space-y-2">
                <label htmlFor="paste-import-text" className="text-[10px] text-slate-400 uppercase tracking-wider">
                  Paste resume text
                </label>
                <textarea
                  id="paste-import-text"
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder="Paste the full text of your resume here…"
                  rows={6}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handlePasteImport}
                    disabled={uploading}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg font-medium transition-colors disabled:opacity-50"
                  >
                    {uploading ? 'Importing…' : 'Import'}
                  </button>
                  {/* Cancel can't abort the in-flight parse — importFromText
                      would still loadResume() after "cancel", replacing the
                      editor contents. Disable it until the request settles. */}
                  <button
                    onClick={() => { setShowPasteImport(false); setPasteText('') }}
                    disabled={uploading}
                    className="px-3 py-1.5 border border-slate-200 text-slate-500 text-xs rounded-lg font-medium hover:bg-slate-100 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Meta: target role, company, template */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="resume-target-role" className="text-[10px] text-slate-400 uppercase tracking-wider">Target Role</label>
                <input
                  id="resume-target-role"
                  type="text"
                  value={resume.targetRole || ''}
                  onChange={e => update('targetRole', e.target.value)}
                  placeholder="e.g. Senior Product Manager"
                  className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label htmlFor="resume-target-company" className="text-[10px] text-slate-400 uppercase tracking-wider">Target Company</label>
                <input
                  id="resume-target-company"
                  type="text"
                  value={resume.targetCompany || ''}
                  onChange={e => update('targetCompany', e.target.value)}
                  placeholder="e.g. Google"
                  className="w-full mt-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Template selector — grouped by family */}
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Template</label>
              <div className="space-y-2 mt-1">
                {TEMPLATE_FAMILIES.map(family => {
                  const familyTemplates = RESUME_TEMPLATES.filter(
                    t => TEMPLATE_VARIANTS[t.id]?.familyId === family.id,
                  )
                  if (familyTemplates.length === 0) return null
                  return (
                    <div key={family.id}>
                      <div className="text-[9px] text-slate-400 font-medium uppercase tracking-wider mb-1">
                        {family.label}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {familyTemplates.map(t => (
                          <button
                            key={t.id}
                            onClick={() => update('template', t.id)}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                              resume.template === t.id
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-100 text-slate-500 hover:text-slate-900'
                            }`}
                          >
                            {t.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Font & Size */}
            <FontStyleControls
              fontFamily={resume.styling?.fontFamily || 'georgia'}
              headingSize={resume.styling?.headingSize ?? 18}
              bodySize={resume.styling?.bodySize ?? 9}
              onFontFamilyChange={f => update('styling', { ...resume.styling, fontFamily: f as 'georgia' | 'times' | 'garamond' | 'palatino' | 'calibri' | 'helvetica' | 'lato' | 'roboto' })}
              onHeadingSizeChange={s => update('styling', { ...resume.styling, headingSize: s })}
              onBodySizeChange={s => update('styling', { ...resume.styling, bodySize: s })}
            />

            {resume.targetRole && (
              <button
                onClick={handleGenerateFull}
                disabled={enhancingSection === 'full'}
                className="px-3 py-1.5 bg-blue-50 border border-blue-200 text-blue-600 text-[10px] rounded-lg font-medium hover:bg-blue-100 transition-colors disabled:opacity-50"
              >
                {enhancingSection === 'full' ? 'Generating...' : 'AI: Generate suggestions for all sections'}
              </button>
            )}
          </div>

          {/* Contact info — fixed at the top: every template renders it as a
              header outside the reorderable body, so it never gets a handle. */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
            {renderSectionEditor('contactInfo')}
          </div>

          {/* Section editors — drag to reorder (single-column templates only) */}
          {honorsSectionOrder ? (
            <SortableList items={sectionIds} onReorder={reorderSections}>
              <div className="space-y-5">
                {sectionIds.map(sectionId => (
                  <SortableItem key={sectionId} id={sectionId}>
                    {({ listeners, attributes }) => (
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                        <div className="flex items-start gap-2">
                          <div className="pt-1">
                            <DragHandle listeners={listeners} attributes={attributes} />
                          </div>
                          <div className="flex-1 min-w-0">
                            {renderSectionEditor(sectionId)}
                          </div>
                        </div>
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableList>
          ) : (
            <div className="space-y-5">
              {/* Columnar templates (Sidebar/Creative, Startup) render a fixed
                  two-column layout, so section order can't be changed — hide the
                  drag affordance rather than show a no-op handle. */}
              <p className="text-[11px] text-slate-400">
                This template uses a fixed layout — section order can&apos;t be changed.
                Switch to a single-column template to reorder sections.
              </p>
              {sectionIds.map(sectionId => (
                <div key={sectionId} className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                  {renderSectionEditor(sectionId)}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preview Panel - full width on mobile, 50% on desktop */}
        <div className={`w-full md:w-1/2 md:shrink-0 md:sticky md:top-4 self-start ${mobileTab === 'edit' ? 'hidden md:block' : ''}`}>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2 font-semibold">Live Preview</div>
          <ResumePreview data={resume} templateId={resume.template || 'professional'} />
        </div>
      </div>
    </div>
  )
}
