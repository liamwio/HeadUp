import {afterEach,describe,expect,it,vi} from 'vitest'
import {rotatePhotoFile} from './prepareCaptureFile'

const mocks=vi.hoisted(()=>({preflight:vi.fn(async()=>({}))}))
vi.mock('./imageInputPreflight',()=>({preflightImageFile:mocks.preflight}))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})

describe('upright image rendering resources',()=>{
  const file=new File(['local'],'input.jpg',{type:'image/jpeg',lastModified:123})
  it('keeps the original canvas size and applies the signed rotation without flipping or scaling',async()=>{
    const close=vi.fn(),context={fillStyle:'',fillRect:vi.fn(),translate:vi.fn(),rotate:vi.fn(),drawImage:vi.fn()}
    const sample={width:0,height:0,getContext:()=>({drawImage:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray(16*16*4).fill(128)})})}
    const canvas={width:0,height:0,getContext:()=>context,toBlob:(callback:(blob:Blob)=>void)=>callback(new Blob(['png'],{type:'image/png'}))}
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1200,height:1600,close})))
    vi.stubGlobal('document',{createElement:vi.fn().mockReturnValueOnce(sample).mockReturnValueOnce(canvas)})
    const result=await rotatePhotoFile(file,-12)
    expect(mocks.preflight).toHaveBeenCalledWith(file)
    expect([canvas.width,canvas.height]).toEqual([1200,1600])
    expect(context.translate).toHaveBeenCalledWith(600,800)
    expect(context.rotate).toHaveBeenCalledWith(-12*Math.PI/180)
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([-600,-800])
    expect(result.type).toBe('image/png');expect(result.lastModified).toBe(123)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it.each(['size','canvas'])('closes decoded pixels after a %s failure',async failure=>{
    const close=vi.fn()
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:failure==='size'?5000:1200,height:5000,close})))
    vi.stubGlobal('document',{createElement:()=>({getContext:()=>null})})
    await expect(rotatePhotoFile(file,12)).rejects.toThrow(failure==='size'?'rotation_size_limit':'rotation_canvas_unavailable')
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid angles before decoding',async()=>{
    const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode)
    await expect(rotatePhotoFile(file,NaN)).rejects.toThrow('rotation_angle_limit')
    await expect(rotatePhotoFile(file,90)).rejects.toThrow('rotation_angle_limit')
    expect(decode).not.toHaveBeenCalled()
  })
})
