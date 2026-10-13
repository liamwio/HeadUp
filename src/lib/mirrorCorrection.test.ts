import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ preflight: vi.fn() }))
vi.mock('./imageInputPreflight', () => ({ preflightImageFile: mocks.preflight }))
import { correctMirroredFrontFile } from './mirrorCorrection'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('correctMirroredFrontFile', () => {
  it('preflights, flips into lossless PNG, and closes the source bitmap', async () => {
    const close = vi.fn()
    const context = { translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn() }
    const canvas = {
      width: 0, height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close })))
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
    const source = new File([new Uint8Array([1, 2, 3])], 'front.photo.jpg', { type: 'image/jpeg', lastModified: 123 })

    const corrected = await correctMirroredFrontFile(source)

    expect(mocks.preflight).toHaveBeenCalledWith(source)
    expect(canvas.width).toBe(2)
    expect(canvas.height).toBe(1)
    expect(context.translate).toHaveBeenCalledWith(2, 0)
    expect(context.scale).toHaveBeenCalledWith(-1, 1)
    expect(context.drawImage).toHaveBeenCalledOnce()
    expect(corrected.name).toBe('front.photo-mirror-corrected.png')
    expect(corrected.type).toBe('image/png')
    expect(corrected.lastModified).toBe(123)
    expect(close).toHaveBeenCalledOnce()
  })

  it('still closes the bitmap when canvas rendering is unavailable', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close })))
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ width: 0, height: 0, getContext: () => null })) })
    const source = new File([new Uint8Array([1])], 'front.jpg', { type: 'image/jpeg' })

    await expect(correctMirroredFrontFile(source)).rejects.toThrow('无法执行镜像纠正')
    expect(close).toHaveBeenCalledOnce()
  })
})
