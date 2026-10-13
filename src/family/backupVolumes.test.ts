import {it,expect} from 'vitest'
import {prepareBackupVolumes,decryptBackupFiles} from './backupVolumes'
import {encryptArchive} from './backup'
import {archiveFixture} from './backupVolumes.fixture'

it('roundtrips a complete revision chain across arbitrary binary boundaries and input order',async()=>{
  const archive=archiveFixture(),plan=await prepareBackupVolumes(archive,'test-only-password',1024)
  expect(plan.count).toBeGreaterThan(1)
  const files=[];for(let i=0;i<plan.count;i++)files.push(await plan.volume(i))
  expect(await files[0].text()).not.toContain('测试私密昵称')
  const restored=await decryptBackupFiles(files.reverse(),'test-only-password')
  expect(restored.sessions.length).toBe(2);expect(restored.sessions[1].revision).toEqual(archive.sessions[1].revision)
  expect(restored.sessions[0].contentKey).toMatch(/^front:[0-9a-f]{64}$/)
  expect(await restored.media[1].originalBlob!.arrayBuffer()).toEqual(await archive.media[1].originalBlob!.arrayBuffer())
  archive.media[1].originalBlob=new Blob([archive.media[1].originalBlob!,new Uint8Array([1])],{type:'image/png'})
  const substituted=await prepareBackupVolumes(archive,'test-only-password')
  await expect(decryptBackupFiles([await substituted.volume(0)],'test-only-password')).rejects.toThrow('格式不正确')
})
it('rejects incomplete, duplicate, mixed, tampered and wrong-password volumes',async()=>{
  const source=archiveFixture(),a=await prepareBackupVolumes(source,'test-only-password',4096),b=await prepareBackupVolumes(source,'test-only-password',4096)
  const files=[];for(let i=0;i<a.count;i++)files.push(await a.volume(i))
  await expect(decryptBackupFiles(files.slice(1),'test-only-password')).rejects.toThrow()
  await expect(decryptBackupFiles([...files.slice(0,-1),files[0]],'test-only-password')).rejects.toThrow('重复')
  await expect(decryptBackupFiles([...files.slice(0,-1),await b.volume(b.count-1)],'test-only-password')).rejects.toThrow('另一套')
  await expect(decryptBackupFiles(files,'wrong-password')).rejects.toThrow('密码')
  const bytes=new Uint8Array(await files[0].arrayBuffer());bytes[bytes.length-1]^=1
  await expect(decryptBackupFiles([new Blob([bytes]),...files.slice(1)],'test-only-password')).rejects.toThrow('损坏')
})
it('keeps old single-file backups readable and supports cancellation before mutation',async()=>{
  const archive=archiveFixture(),old=await encryptArchive(archive,'test-only-password')
  expect((await decryptBackupFiles([old],'test-only-password')).sessions.length).toBe(2)
  const controller=new AbortController();controller.abort()
  await expect(decryptBackupFiles([old],'test-only-password',undefined,controller.signal)).rejects.toThrow('取消')
})
it('authenticates the volume header as well as encrypted bytes',async()=>{
  const plan=await prepareBackupVolumes(archiveFixture(),'test-only-password'),file=await plan.volume(0),bytes=new Uint8Array(await file.arrayBuffer())
  const length=new DataView(bytes.buffer).getUint32(8,false),header=JSON.parse(new TextDecoder().decode(bytes.slice(12,12+length)));header.metadataBytes++
  const replaced=new TextEncoder().encode(JSON.stringify(header)),prefix=bytes.slice(0,12);new DataView(prefix.buffer).setUint32(8,replaced.length,false)
  await expect(decryptBackupFiles([new Blob([prefix,replaced,bytes.slice(12+length)])],'test-only-password')).rejects.toThrow('损坏')
})
it('plans binary volumes beyond the old 100MB photo limit without base64 expansion',async()=>{
  const archive=archiveFixture(),blob=new Blob([new Uint8Array(26*1024*1024)],{type:'image/png'})
  archive.media=archive.media.map(m=>({...m,blob,originalBlob:blob}))
  const plan=await prepareBackupVolumes(archive,'test-only-password')
  expect(plan.totalBytes).toBeGreaterThan(100*1024*1024);expect(plan.count).toBe(7)
  expect(plan.totalBytes).toBeLessThan(105*1024*1024)
})
if(process.env.HEADUP_VOLUME_UI_FIXTURE==='1')it('writes isolated UI fixture volumes and verifies their filesystem roundtrip',async()=>{
  const {mkdtemp,writeFile,readFile,mkdir}=await import('node:fs/promises'),{resolve,join}=await import('node:path')
  const base=resolve('.tmp');await mkdir(base,{recursive:true});const folder=await mkdtemp(join(base,'family-volume-ui-'))
  const plan=await prepareBackupVolumes(archiveFixture(),'only-for-volume-ui',4096),paths:string[]=[],files:Blob[]=[]
  for(let i=0;i<plan.count;i++){const path=join(folder,plan.filename(i));await writeFile(path,new Uint8Array(await(await plan.volume(i)).arrayBuffer()));paths.push(path);files.push(new Blob([await readFile(path)]))}
  expect((await decryptBackupFiles(files,'only-for-volume-ui')).sessions.length).toBe(2)
  console.log('HEADUP_UI_FIXTURE_FILES='+JSON.stringify(paths))
})
