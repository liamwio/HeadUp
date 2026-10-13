import {archiveSchema} from './backup'
import {decryptArchive,validateArchivePayload,type Archive} from './backup'
import {localDate} from './model'

const MAGIC=new TextEncoder().encode('HEADUP2\n'),PART_BYTES=16*1024*1024,MAX_SET_BYTES=2*1024*1024*1024,MAX_META_BYTES=32*1024*1024,MAX_PARTS=4096
type Header={schema:'headup-family-part-v2';setId:string;index:number;count:number;chunkBytes:number;totalBytes:number;metadataBytes:number;salt:string;iv:string}
type ReadPart={file:Blob;header:Header;aad:Uint8Array<ArrayBuffer>;offset:number}
type Location={offset:number;size:number}
const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v))
const hex=(v:Uint8Array)=>Array.from(v,b=>b.toString(16).padStart(2,'0')).join('')
function unhex(value:string,length:number){if(!new RegExp(`^[0-9a-f]{${length*2}}$`).test(value))throw new Error('备份卷头无效');return Uint8Array.from(value.match(/../g)!,s=>parseInt(s,16))}
async function derive(password:string,salt:Uint8Array<ArrayBuffer>){if(password.length<8||password.length>128)throw new Error('备份密码需要8–128个字符');const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
const cancelled=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('已取消','AbortError')}
export type BackupVolumePlan={setId:string;count:number;totalBytes:number;filename:(index:number)=>string;volume:(index:number,signal?:AbortSignal)=>Promise<Blob>}

/** Payload is a Blob of metadata plus binary photos; only a bounded slice is encrypted at a time. */
export async function prepareBackupVolumes(archive:Archive,password:string,chunkBytes=PART_BYTES):Promise<BackupVolumePlan>{
  if(!Number.isSafeInteger(chunkBytes)||chunkBytes<256||chunkBytes>PART_BYTES)throw new Error('分卷大小无效')
  let offset=0;const pieces:Blob[]=[]
  const location=(blob:Blob):Location=>{const entry={offset,size:blob.size};offset+=blob.size;pieces.push(blob);return entry}
  const media=archive.media.map(m=>({id:m.id,sessionId:m.sessionId,profileId:m.profileId,type:m.blob.type,blob:location(m.blob),originalType:m.originalBlob?.type,original:m.originalBlob?location(m.originalBlob):undefined}))
  const metadata=encode({...archive,media,schema:archiveSchema(archive)==='headup-family-archive-v3'?'headup-family-binary-v4':archiveSchema(archive)==='headup-family-archive-v2'?'headup-family-binary-v3':'headup-family-binary-v2'})
  if(metadata.length>MAX_META_BYTES||offset+metadata.length>MAX_SET_BYTES)throw new Error('所选范围超过单套备份容量，请按年份或月份缩小日期范围；不会省略任何记录。')
  const payload=new Blob([metadata,...pieces]),count=Math.ceil(payload.size/chunkBytes)
  if(count>MAX_PARTS)throw new Error('备份分卷过多，请增加分卷大小或缩小日期范围')
  const setId=crypto.randomUUID(),salt=crypto.getRandomValues(new Uint8Array(16)),secret=await derive(password,salt)
  return {setId,count,totalBytes:payload.size,filename:index=>`headup-${localDate()}-${setId.slice(0,8)}-${String(index+1).padStart(3,'0')}-of-${String(count).padStart(3,'0')}.headup`,
    async volume(index,signal){
      if(!Number.isInteger(index)||index<0||index>=count)throw new Error('分卷编号无效');cancelled(signal)
      // Fresh IV on every generation, including a user retry of the same part.
      const iv=crypto.getRandomValues(new Uint8Array(12)),header:Header={schema:'headup-family-part-v2',setId,index,count,chunkBytes,totalBytes:payload.size,metadataBytes:metadata.length,salt:hex(salt),iv:hex(iv)},aad=encode(header)
      const plain=await payload.slice(index*chunkBytes,Math.min((index+1)*chunkBytes,payload.size)).arrayBuffer();cancelled(signal)
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128},secret,plain);cancelled(signal)
      const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,aad.length,false)
      return new Blob([MAGIC,length,aad,encrypted],{type:'application/octet-stream'})
    }}
}
async function readPart(file:Blob):Promise<ReadPart>{
  if(file.size>PART_BYTES+4096||file.size<MAGIC.length+4)throw new Error('备份卷大小无效')
  const prefix=new Uint8Array(await file.slice(0,MAGIC.length+4).arrayBuffer())
  if(!MAGIC.every((b,i)=>prefix[i]===b))throw new Error('请选择同一套分卷备份的全部文件')
  const size=new DataView(prefix.buffer).getUint32(MAGIC.length,false);if(size<1||size>2048)throw new Error('备份卷头过大或缺失')
  const offset=MAGIC.length+4+size,aad=new Uint8Array(await file.slice(MAGIC.length+4,offset).arrayBuffer())
  let h:Header;try{h=JSON.parse(new TextDecoder().decode(aad))}catch{throw new Error('备份卷头损坏')}
  if(!h||Object.keys(h).sort().join(',')!==['schema','setId','index','count','chunkBytes','totalBytes','metadataBytes','salt','iv'].sort().join(',')||h.schema!=='headup-family-part-v2'||typeof h.setId!=='string'||!/^[-0-9a-f]{36}$/.test(h.setId)||![h.index,h.count,h.chunkBytes,h.totalBytes,h.metadataBytes].every(Number.isSafeInteger)||h.index<0||h.count<1||h.count>MAX_PARTS||h.index>=h.count||h.chunkBytes<256||h.chunkBytes>PART_BYTES||h.totalBytes<1||h.totalBytes>MAX_SET_BYTES||h.count!==Math.ceil(h.totalBytes/h.chunkBytes)||h.metadataBytes<1||h.metadataBytes>Math.min(h.totalBytes,MAX_META_BYTES))throw new Error('备份分卷信息无效')
  unhex(h.salt,16);unhex(h.iv,12)
  const expected=Math.min(h.chunkBytes,h.totalBytes-h.index*h.chunkBytes)
  if(file.size-offset!==expected+16)throw new Error('备份卷不完整')
  return {file,header:h,aad,offset}
}
/** Authentication and full archive validation finish before callers may commit to IndexedDB. */
export async function decryptBackupFiles(files:Blob[],password:string,onProgress?:(done:number,total:number)=>void,signal?:AbortSignal):Promise<Archive>{
  if(!files.length||files.length>MAX_PARTS)throw new Error('请选择完整备份文件')
  cancelled(signal)
  const prefix=new Uint8Array(await files[0].slice(0,MAGIC.length).arrayBuffer())
  if(!MAGIC.every((b,i)=>prefix[i]===b)){if(files.length!==1)throw new Error('旧版备份请一次导入一个文件');const archive=await decryptArchive(files[0],password);cancelled(signal);return archive}
  const parts:ReadPart[]=[];for(const file of files){cancelled(signal);parts.push(await readPart(file))}
  const first=parts[0].header,common=(h:Header)=>JSON.stringify([h.setId,h.count,h.chunkBytes,h.totalBytes,h.metadataBytes,h.salt])
  if(parts.length!==first.count)throw new Error(`这套备份需要${first.count}卷，当前选择${parts.length}卷。请补齐后再导入。`)
  if(parts.some(p=>common(p.header)!==common(first)))throw new Error('混入了另一套备份，请重新选择同一套全部分卷')
  if(new Set(parts.map(p=>p.header.index)).size!==parts.length)throw new Error('存在重复分卷，请重新选择')
  const secret=await derive(password,unhex(first.salt,16)),decoded:Blob[]=[];parts.sort((a,b)=>a.header.index-b.header.index)
  for(const part of parts){cancelled(signal);try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(part.header.iv,12),additionalData:part.aad,tagLength:128},secret,await part.file.slice(part.offset).arrayBuffer());decoded.push(new Blob([plain]))}catch{throw new Error('密码不正确或备份卷已损坏，当前档案未修改。')}onProgress?.(decoded.length,parts.length)}
  cancelled(signal);const payload=new Blob(decoded)
  let manifest:any;try{manifest=JSON.parse(await payload.slice(0,first.metadataBytes).text())}catch{throw new Error('备份目录损坏')}
  if(!['headup-family-binary-v2','headup-family-binary-v3','headup-family-binary-v4'].includes(manifest?.schema)||!Array.isArray(manifest.media))throw new Error('备份目录格式无效')
  // Require complete, contiguous ownership of the media region, including original photos.
  let next=0;for(const media of manifest.media){for(const field of ['blob','original']){const item=media[field];if(field==='original'&&item===undefined)continue;if(!item||!Number.isSafeInteger(item.offset)||!Number.isSafeInteger(item.size)||item.offset!==next||item.size<1||item.size>30*1024*1024)throw new Error('备份照片索引无效');next+=item.size}}
  if(next+first.metadataBytes!==payload.size)throw new Error('备份照片内容不完整')
  const archive=await validateArchivePayload({...manifest,schema:manifest.schema==='headup-family-binary-v4'?'headup-family-archive-v3':manifest.schema==='headup-family-binary-v3'?'headup-family-archive-v2':'headup-family-archive-v1'},{maxPhotoBytes:MAX_SET_BYTES,photo(media,original){const item=media[original?'original':'blob'] as Location;return payload.slice(first.metadataBytes+item.offset,first.metadataBytes+item.offset+item.size)}})
  cancelled(signal);return archive
}
