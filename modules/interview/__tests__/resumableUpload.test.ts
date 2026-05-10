import { getPartRange } from '@interview/utils/resumableUpload'

describe('resumable replay upload helpers', () => {
  it('splits multipart upload ranges without exceeding the blob size', () => {
    const partSize = 8 * 1024 * 1024
    const size = partSize * 2 + 123

    expect(getPartRange(1, size, partSize)).toEqual({ start: 0, end: partSize })
    expect(getPartRange(2, size, partSize)).toEqual({ start: partSize, end: partSize * 2 })
    expect(getPartRange(3, size, partSize)).toEqual({ start: partSize * 2, end: size })
  })
})
