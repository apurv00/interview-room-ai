import { describe, expect, it } from 'vitest'
import { JobPosting } from '../models/JobPosting'

describe('JobPosting durable source lineage', () => {
  it.each([
    ['the default', undefined],
    ['an explicit empty array', []],
    ['a blank identifier', ['']],
    ['a whitespace-only identifier', ['   ']],
    ['a padded identifier', [' gh:phonepe ']],
    ['an uppercase identifier', ['GH:phonepe']],
    ['an identifier with path punctuation', ['gh/phonepe']],
    ['an overlong identifier', [`a${'b'.repeat(100)}`]],
    ['a null array entry', [null]],
  ])('rejects %s because every new document needs a durable source id', (_name, sourceIds) => {
    const posting = new JobPosting(sourceIds === undefined ? {} : { sourceIds })

    expect(posting.validateSync()?.errors.sourceIds).toBeDefined()
  })

  it.each([['gh:phonepe'], ['__legacy_unknown__']])(
    'accepts canonical durable source-id array %j',
    (sourceIds) => {
      const posting = new JobPosting({ sourceIds })

      expect(posting.validateSync()?.errors.sourceIds).toBeUndefined()
    },
  )

  it('applies the same canonical grammar to detailed provenance', () => {
    const posting = new JobPosting({
      sourceIds: ['__legacy_unknown__'],
      provenance: [{
        sourceId: ' gh:phonepe ',
        externalId: '123',
        sourceKey: 'gh:phonepe:123',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      }],
    })

    expect(posting.validateSync()?.errors['provenance.0.sourceId']).toBeDefined()
  })
})
