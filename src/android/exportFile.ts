export type NativeFileWriter={beginExport:(options:{name:string;mime:string;size:number})=>Promise<{token:string}>;appendExport:(options:{token:string;data:string})=>Promise<void>;finishExport:(options:{token:string})=>Promise<void>;abortExport:(options:{token:string})=>Promise<void>}
export async function writeNativeFile(client:NativeFileWriter,blob:Blob,name:string,onProgress:(percent:number)=>void=()=>{}){
  if(blob.size>64*1024*1024)throw new Error('本次文件超过64MB，请改用分卷备份或缩小导出范围')
  let token:string|undefined
  try{
    token=(await client.beginExport({name:name||'headup-export',mime:blob.type||'application/octet-stream',size:blob.size})).token
    for(let start=0;start<blob.size;start+=192*1024){
      const bytes=new Uint8Array(await blob.slice(start,start+192*1024).arrayBuffer());let text=''
      for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192))
      await client.appendExport({token,data:btoa(text)});onProgress(Math.min(100,Math.round((start+bytes.length)/blob.size*100)))
    }
    await client.finishExport({token});token=undefined
  }catch(error){if(token)await client.abortExport({token}).catch(()=>{});throw error}
}
