import { describe, expect, it } from 'vitest'
import { HireMultimodalObservation } from '../models/HireMultimodalObservation'

describe('Hire supplemental-observation model', () => {
  it('stores versioned validation capture states beneath report.capture', () => {
    expect(
      HireMultimodalObservation.schema.path('report.capture.browserFocus'),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path('report.capture.fullscreen'),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path('report.capture.cameraTrack'),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path('report.capture.microphoneTrack'),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path('report.capture.displayShare'),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path(
        'report.capture.speechVideoCorroboration',
      ),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path(
        'report.playbackClock.protocolVersion',
      ),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path(
        'report.playbackClock.cameraRecorderStartOffsetMs',
      ),
    ).toBeDefined()
    expect(
      HireMultimodalObservation.schema.path(
        'report.playbackClock.screenRecorderStartOffsetMs',
      ),
    ).toBeDefined()
    expect(HireMultimodalObservation.schema.path('report.browserFocus')).toBeUndefined()
  })
})
