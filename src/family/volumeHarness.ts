import {archiveFixture} from './backupVolumes.fixture'
import {prepareBackupVolumes,decryptBackupFiles} from './backupVolumes'
import {FamilyStore} from './store'
import {sortedSessions} from './model'

const small=document.getElementById('small') as HTMLButtonElement,large=document.getElementById('large') as HTMLButtonElement,status=document.getElementById('status')!,output=document.getElementById('result')!
async function run(big:boolean){
  output.textContent='';small.disabled=large.disabled=true;const name=`headup-volume-qa-${crypto.randomUUID()}`,store=new FamilyStore(name),checks:Array<{name:string;pass:boolean}>=[],started=performance.now()
  const check=(name:string,pass:boolean)=>{checks.push({name,pass});if(!pass)throw new Error(name)}
  try{
    const archive=archiveFixture()
    if(big){const original=archive.media[0].blob,blob=new Blob([original,new Uint8Array(26*1024*1024-original.size)],{type:'image/png'});archive.media=archive.media.map(m=>({...m,blob,originalBlob:blob}))}
    status.textContent='正在准备分卷…';const plan=await prepareBackupVolumes(archive,'only-for-volume-qa',big?16*1024*1024:1024),files:Blob[]=[]
    for(let i=0;i<plan.count;i++){status.textContent=`正在加密第${i+1}/${plan.count}卷…`;files.push(await plan.volume(i))}
    check('分卷已生成且覆盖整个快照',files.length===plan.count&&plan.count>1)
    if(big)check('实际处理超过旧版100MB照片上限',plan.totalBytes>100*1024*1024)
    const restore=async(parts:Blob[])=>{const decoded=await decryptBackupFiles(parts,'only-for-volume-qa',(done,total)=>{status.textContent=`正在解密并校验${done}/${total}卷…`});await store.restore(decoded);return decoded}
    let missing=false;try{await restore(files.slice(1))}catch{missing=true}
    check('缺卷拒绝且未写入任何档案',missing&&(await store.snapshot()).profiles.length===0)
    const altered=new Uint8Array(await files[0].arrayBuffer());altered[altered.length-1]^=1
    let damaged=false;try{await restore([new Blob([altered]),...files.slice(1)])}catch{damaged=true}
    check('损坏卷拒绝且未留下记录或照片',damaged&&(await store.archive()).sessions.length===0&&(await store.archive()).media.length===0)
    const decoded=await restore([...files].reverse())
    check('任意文件选择顺序恢复全部版本与原图',decoded.sessions.length===2&&decoded.media.length===2&&decoded.media.every(m=>m.originalBlob?.size===archive.media[0].originalBlob?.size))
    await store.close();const saved=await store.snapshot()
    check('关闭连接后恢复内容仍存在且只计一次记录',saved.sessions.length===2&&sortedSessions(saved.sessions,archive.profiles[0].id).length===1)
    const photo=await store.getMedia(decoded.media[0].id),bitmap=await createImageBitmap(photo!.blob)
    check('恢复后的真实PNG可解码且尺寸未改变',bitmap.width===64&&bitmap.height===64);bitmap.close()
    status.textContent='PASS：分卷、认证、原子恢复和照片解码全部通过'
    output.textContent=JSON.stringify({pass:true,largeBoundary:big,totalBytes:plan.totalBytes,volumes:plan.count,elapsedMs:Math.round(performance.now()-started),checks,isolatedDatabase:true},null,2)
  }catch(error){status.textContent='FAIL：本轮未通过';output.textContent=JSON.stringify({pass:false,checks,error:error instanceof Error?error.message:String(error)},null,2)}
  finally{await store.close();await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)});small.disabled=large.disabled=false}
}
small.onclick=()=>void run(false);large.onclick=()=>void run(true)
