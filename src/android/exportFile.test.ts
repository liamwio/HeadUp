import {it,expect,vi} from 'vitest'
import {writeNativeFile,type NativeFileWriter} from './exportFile'
function writer(){return{beginExport:vi.fn(async()=>({token:'file-one'})),appendExport:vi.fn<NativeFileWriter['appendExport']>(async()=>{}),finishExport:vi.fn(async()=>{}),abortExport:vi.fn(async()=>{})} satisfies NativeFileWriter}
it('saves binary data in bounded chunks without altering bytes, then completes exactly once',async()=>{
  const bytes=Uint8Array.from({length:500000},(_,i)=>i%256),client=writer(),chunks:Buffer[]=[]
  client.appendExport.mockImplementation(async(options:any)=>{expect(options.token).toBe('file-one');const chunk=Buffer.from(options.data,'base64');expect(chunk.length).toBeLessThanOrEqual(192*1024);chunks.push(chunk)})
  await writeNativeFile(client,new Blob([bytes],{type:'application/octet-stream'}),'backup.headup')
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));expect(client.finishExport).toHaveBeenCalledExactlyOnceWith({token:'file-one'});expect(client.abortExport).not.toHaveBeenCalled()
})
it('aborts an incomplete write, preserves its original error and never reports completion',async()=>{
  const client=writer(),error=new Error('storage full');client.appendExport.mockRejectedValue(error);client.abortExport.mockRejectedValue(new Error('already closed'))
  await expect(writeNativeFile(client,new Blob(['personal backup']),'backup.headup')).rejects.toBe(error)
  expect(client.abortExport).toHaveBeenCalledExactlyOnceWith({token:'file-one'});expect(client.finishExport).not.toHaveBeenCalled()
})
it('does not attempt to write after the user cancels the destination picker',async()=>{
  const client=writer();client.beginExport.mockRejectedValue(new Error('cancelled'))
  await expect(writeNativeFile(client,new Blob(['backup']),'backup.headup')).rejects.toThrow('cancelled');expect(client.appendExport).not.toHaveBeenCalled();expect(client.abortExport).not.toHaveBeenCalled()
})
