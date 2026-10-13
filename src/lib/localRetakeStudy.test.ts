import { describe, expect, it } from 'vitest'
import { buildLocalRetakeStudySession, type LocalRetakeCaptureResult } from './localRetakeStudy'

function capture(repeat: number, combinedPass = true): LocalRetakeCaptureResult {
  return {
    repeat,
    width: 3024,
    height: 4032,
    qualityScore: 88,
    qualityPass: true,
    posePass: combinedPass,
    combinedPass,
    qualityFlags: [],
    poseFlags: [],
    geometry: combinedPass ? {
      mirrorResidual: 0.02123456 + repeat / 1000,
      visibleFaceLengthWidthRatio: 1.18,
      pupilDistanceFaceWidthRatio: 0.43,
      interEyeRatio: 1.2,
      eyeCanthalTiltDegrees: -1.4,
      jawWidthRatio: 0.79,
      mouthWidthRatio: 0.36,
      midfaceHeightRatio: 0.37,
      browPeakMidfaceHeightRatio:0.41,
      lowerFaceHeightRatio: 0.39,
      noseMouthWidthRatio: 0.68,
      noseLengthFaceHeightRatio: 0.22,
      lipHeightMouthWidthRatio: 0.31,
    } : null,
  }
}

describe('local real-person retake session', () => {
  it('serializes three anonymous measurement attempts without images or landmarks', () => {
    const result = buildLocalRetakeStudySession([capture(3), capture(1), capture(2)], {
      pairingToken: '8f35b1d2-554f-4c67-9c8e-5e24b084c032',
      sessionLabel: 'A',
      deviceClass: 'smartphone_front',
      lighting: 'indirect_daylight',
    }, '2026-08-15T00:00:00.000Z')

    expect(result.protocol.protocolComplete).toBe(true)
    expect(result.policyVersion).toBe('HEADUP-LOCAL-RETAKE-SESSION-3.0')
    expect(result.captures.map((item) => item.repeat)).toEqual([1, 2, 3])
    expect(result.captures[0].geometry?.mirrorResidual).toBe(0.022235)
    expect(Object.keys(result.captures[0].geometry ?? {})).toHaveLength(13)
    expect(result.summary.usableMeasurements).toBe(3)
    expect(result.retention).toMatchObject({ imagesIncluded: false, landmarksIncluded: false, browserStorageUsed: false })
    expect(JSON.stringify(result)).not.toContain('.jpg')
  })

  it('marks duplicate or missing repeats incomplete', () => {
    const result = buildLocalRetakeStudySession([capture(1), capture(1)], {
      pairingToken: '8f35b1d2-554f-4c67-9c8e-5e24b084c032',
      sessionLabel: 'B',
      deviceClass: 'smartphone_rear',
      lighting: 'indoor_even',
    })
    expect(result.protocol.protocolComplete).toBe(false)
  })
})
