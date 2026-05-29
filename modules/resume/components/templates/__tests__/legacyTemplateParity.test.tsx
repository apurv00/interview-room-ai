import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { getTemplate } from '../index'
import { FIXTURE, LEGACY_IDS, normalizeClassOrder } from './parityFixture'

/**
 * LEGACY PARITY GATE.
 *
 * The family/primitive refactor must render the 10 legacy template IDs
 * identically to the pre-refactor components (modulo cosmetic Tailwind class
 * ordering — see normalizeClassOrder). The committed snapshot is generated from
 * `origin/main` (pre-refactor); any diff means the refactor changed a legacy
 * template's output, which would silently re-paginate existing users' resumes.
 */
describe('legacy template parity (vs pre-refactor origin/main)', () => {
  for (const id of LEGACY_IDS) {
    it(`${id} renders identically`, () => {
      const html = renderToStaticMarkup(createElement(getTemplate(id), { data: FIXTURE }))
      expect(normalizeClassOrder(html)).toMatchSnapshot()
    })
  }
})
