import {it,expect,vi} from 'vitest'
import {DEFAULT_CAMERA_OPTIONS,requestCaptureHaptic,compactCameraGuidance} from './cameraFeedback'
it('keeps uncertainty and model outages explicit in compact guidance',()=>{
  expect(compactCameraGuidance('侧面角度仍待核对。若手机和头部已端正，请不要继续扭头；可拍下后核对，或调整机位再试。')).toContain('不要继续扭头')
  expect(compactCameraGuidance('实时检测暂不可用，仍可手动拍摄并保存照片。')).toContain('检测暂不可用')
  expect(compactCameraGuidance('请拍右侧面，保持头部自然竖直。')).toBe('请拍右侧面，保持头部自然竖直。')
})
it('defaults sound and vibration off, and does not request feedback when disabled or hidden',()=>{
  expect(DEFAULT_CAMERA_OPTIONS).toMatchObject({voice:false,haptics:false})
  const vibrate=vi.fn(()=>true)
  expect(requestCaptureHaptic({enabled:false,visible:true,vibrate})).toBe(false)
  expect(requestCaptureHaptic({enabled:true,visible:false,vibrate})).toBe(false)
  expect(vibrate).not.toHaveBeenCalled()
})
it('requests one brief pulse without a repeating pattern when enabled and visible',()=>{
  const vibrate=vi.fn(()=>true)
  expect(requestCaptureHaptic({enabled:true,visible:true,vibrate})).toBe(true)
  expect(vibrate).toHaveBeenCalledExactlyOnceWith(40)
})
it('allows capture to continue if vibration is unavailable, rejected or throws',()=>{
  expect(requestCaptureHaptic({enabled:true,visible:true})).toBe(false)
  expect(requestCaptureHaptic({enabled:true,visible:true,vibrate:()=>false})).toBe(false)
  expect(requestCaptureHaptic({enabled:true,visible:true,vibrate:()=>{throw new Error('not allowed')}})).toBe(false)
})
