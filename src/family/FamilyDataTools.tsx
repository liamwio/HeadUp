import {useEffect,useRef,useState} from 'react'
import type {FamilyProfile} from './model'
import {localDate} from './model'
import {familyStore,storageMessage,FAMILY_CHANGE_CHANNEL} from './store'
import type {Archive} from './backup'
import {prepareBackupVolumes,decryptBackupFiles,type BackupVolumePlan} from './backupVolumes'
import {archivePreview,selectArchiveRange,readableArchiveHtml,type ArchiveRange,type ReadableOptions} from './archiveExport'

const size=(n:number)=>n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`
function Preview({archive}:{archive:Archive}){const p=archivePreview(archive);return <div className="family-export-scope"><strong>{p.records}次记录 · {p.versions}个保存版本</strong><p>{p.first?`${p.first} — ${p.last}`:'尚无照片记录'}；{p.photos}张版本照片、{p.originals}张扶正前原图、{p.events}条个人备注，照片约{size(p.bytes)}。</p></div>}
export function FamilyDataTools({profile,onRefresh}:{profile:FamilyProfile;onRefresh:()=>Promise<void>}){
  const [range,setRange]=useState<ArchiveRange>({from:'',to:''}),[password,setPassword]=useState(''),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[snapshot,setSnapshot]=useState<Archive|null>(null),[plan,setPlan]=useState<BackupVolumePlan|null>(null),[downloads,setDownloads]=useState<Record<number,{url:string;name:string}>>({}),[files,setFiles]=useState<File[]>([]),[imported,setImported]=useState<Archive|null>(null)
  const [options,setOptions]=useState<ReadableOptions>({nickname:false,notes:false,photos:false}),[html,setHtml]=useState(''),[htmlUrl,setHtmlUrl]=useState('')
  const alive=useRef(true),urls=useRef<string[]>([]),generation=useRef(0),controller=useRef<AbortController|null>(null),picker=useRef<HTMLInputElement>(null)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;controller.current?.abort();urls.current.forEach(u=>URL.revokeObjectURL(u))}},[])
  const own=(blob:Blob)=>{const url=URL.createObjectURL(blob);urls.current.push(url);return url}
  const reset=()=>{generation.current++;controller.current?.abort();urls.current.forEach(u=>URL.revokeObjectURL(u));urls.current=[];setSnapshot(null);setPlan(null);setDownloads({});setHtml('');setHtmlUrl('');setMessage('')}
  const invalidate=useRef(()=>{});invalidate.current=()=>{if(plan||html||busy==='prepare'||busy==='readable'){reset();setMessage('记录已变化，之前的导出准备或预览已失效，请重新准备。')}}
  useEffect(()=>{let channel:BroadcastChannel|undefined;try{channel=new BroadcastChannel(FAMILY_CHANGE_CHANNEL);channel.onmessage=()=>invalidate.current()}catch{}return()=>channel?.close()},[])
  const loadScope=async()=>selectArchiveRange(await familyStore.archive(profile.id),profile.id,range)
  const prepare=async()=>{
    const token=++generation.current;setBusy('prepare');setMessage('');setPlan(null);setDownloads({})
    try{const archive=await loadScope(),prepared=await prepareBackupVolumes(archive,password);if(!alive.current||token!==generation.current)return;urls.current.forEach(u=>URL.revokeObjectURL(u));urls.current=[];setHtmlUrl('');setHtml('');setSnapshot(archive);setPlan(prepared);setPassword('');setMessage(`已准备${prepared.count}卷。请逐卷下载并保管完整一套；仅准备完成不表示已保存到设备。`)}catch(e){if(alive.current)setMessage(storageMessage(e))}finally{if(alive.current)setBusy('')}
  }
  const volume=async(index:number)=>{
    if(!plan)return;const token=generation.current,c=new AbortController();controller.current=c;setBusy(`part-${index}`);setMessage('正在生成这一卷…')
    try{const blob=await plan.volume(index,c.signal);if(!alive.current||token!==generation.current||c.signal.aborted)return;setDownloads(v=>({...v,[index]:{url:own(blob),name:plan.filename(index)}}));setMessage(`第${index+1}卷已生成，请点击对应下载链接并确认浏览器保存。`)}catch(e){if(alive.current)setMessage(c.signal.aborted?'已取消生成，档案未改变。':storageMessage(e))}finally{if(alive.current)setBusy('')}
  }
  const inspect=async()=>{
    const c=new AbortController();controller.current=c;setBusy('inspect');setImported(null);setMessage('正在检查备份…')
    try{const archive=await decryptBackupFiles(files,password,(done,total)=>{if(alive.current)setMessage(`已解密${done}/${total}卷，完成全部校验前不会写入档案。`)},c.signal);if(!alive.current||c.signal.aborted)return;setImported(archive);setPassword('');setMessage('备份已通过校验，尚未写入本机。请核对范围后恢复。')}catch(e){if(alive.current)setMessage(c.signal.aborted?'已取消检查，本机档案未改变。':storageMessage(e))}finally{if(alive.current)setBusy('')}
  }
  const readable=async()=>{
    const token=++generation.current;setBusy('readable');setMessage('')
    try{const archive=await loadScope(),text=await readableArchiveHtml(archive,options);if(!alive.current||token!==generation.current)return;if(htmlUrl)URL.revokeObjectURL(htmlUrl);setHtml(text);setHtmlUrl(own(new Blob([text],{type:'text/html;charset=utf-8'})));setMessage('资料预览已生成，请检查后保存。它只包含各次最新版，完整修订请使用加密备份。')}catch(e){if(alive.current)setMessage(storageMessage(e))}finally{if(alive.current)setBusy('')}
  }
  return <div className="family-data-tools"><section className="family-settings-section"><h2>选择导出范围</h2><p>当前档案：{profile.nickname}。留空表示全部日期；范围内每次记录的全部修订会一起备份。档案信息与当前计划也会保留。</p><div className="family-form-grid"><label>起始日期<input type="date" disabled={Boolean(busy)} max={localDate()} value={range.from} onInput={e=>{const value=e.currentTarget.value;reset();setRange(r=>({...r,from:value}))}} onChange={e=>{reset();setRange(r=>({...r,from:e.target.value}))}}/></label><label>结束日期<input type="date" disabled={Boolean(busy)} max={localDate()} value={range.to} onInput={e=>{const value=e.currentTarget.value;reset();setRange(r=>({...r,to:value}))}} onChange={e=>{reset();setRange(r=>({...r,to:e.target.value}))}}/></label></div><button disabled={Boolean(busy)} onClick={()=>{reset();setRange({from:'',to:''})}}>全部日期</button></section>
    <section className="family-settings-section"><h2>加密备份与恢复</h2><p>照片、原图、读数、备注和全部修订会拆成约16MB一卷。单套上限2GB，更多资料可按日期分套。恢复时一次选择同一套的全部文件；缺卷或损坏时不会部分导入。</p><label>本次备份或解锁密码<input type="password" autoComplete="off" disabled={Boolean(busy)} minLength={8} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} placeholder="至少8个字符，密码不上传、不保存"/></label><div className="family-actions"><button disabled={Boolean(busy)||password.length<8} onClick={()=>void prepare()}>准备所选范围的加密备份</button><button disabled={Boolean(busy)} onClick={()=>picker.current?.click()}>选择备份文件（可多选）</button></div><input hidden multiple ref={picker} type="file" accept=".headup,application/json,application/octet-stream" onChange={e=>{setFiles(Array.from(e.target.files??[]));setImported(null);setMessage('');e.target.value=''}}/>
      {plan&&<div className="family-backup-parts"><h3>本套 {plan.setId.slice(0,8)} · 共{plan.count}卷</h3>{snapshot&&<Preview archive={snapshot}/>}<p>数据以准备时的快照为准；新增、更正或删除记录后请重新准备。下载过的卷仍可再次下载，恢复依据卷编号校验，与选择顺序无关。</p><ol>{Array.from({length:plan.count},(_,i)=><li key={i}><span>第{i+1}/{plan.count}卷</span>{downloads[i]?<a className="family-file-link" href={downloads[i].url} download={downloads[i].name}>下载第{i+1}卷</a>:<button disabled={Boolean(busy)} onClick={()=>void volume(i)}>{busy===`part-${i}`?'生成中…':'生成本卷下载文件'}</button>}</li>)}</ol><button disabled={Boolean(busy)} onClick={reset}>清除本次准备的文件</button></div>}
      {files.length>0&&<div className="family-import-preview"><p>已选择{files.length}个文件，共{size(files.reduce((n,f)=>n+f.size,0))}。</p><button disabled={Boolean(busy)||password.length<8} onClick={()=>void inspect()}>解锁并检查备份</button></div>}
      {imported&&<div className="family-import-preview"><h3>准备恢复的内容</h3><p>档案：{imported.profiles.map(p=>p.nickname).join('、')}</p><Preview archive={imported}/><p>{imported.profiles.length}个档案；按档案ID识别，不按昵称合并。同名但不同ID的档案分别保留；已有内容保持本机版本，修订分支冲突时整次拒绝。</p><button className="family-primary" disabled={Boolean(busy)} onClick={async()=>{setBusy('restore');try{await familyStore.restore(imported);await onRefresh();if(alive.current){setImported(null);setFiles([]);setMessage('备份内容已恢复到本机；已存在记录未覆盖。')}}catch(e){if(alive.current)setMessage(storageMessage(e))}finally{if(alive.current)setBusy('')}}}>将这套备份恢复到本机</button></div>}
      <p>请保管完整分卷与密码；应用不能找回密码。旧版单文件备份仍可导入；含个人档案或三视角结果的新备份，需要使用1.1版或更新版本恢复。备份文件会包含个人照片，不能当成普通资料分享。</p>
    </section>
    <section className="family-settings-section"><h2>导出可阅读的资料</h2><p>按上方日期范围生成HTML资料包，可在浏览器打开或打印。默认只含最新保存读数、误差、检测提示与版本；不包含照片、昵称和备注。</p><div className="family-export-options">{([['nickname','加入昵称'],['notes','加入个人备注'],['photos','加入原图和分析用图（合计不超过30MB）']] as const).map(([key,label])=><label className="family-inline-check" key={key}><input type="checkbox" disabled={Boolean(busy)} checked={options[key]} onChange={e=>{setOptions(v=>({...v,[key]:e.target.checked}));setHtml('');if(htmlUrl)URL.revokeObjectURL(htmlUrl);setHtmlUrl('')}}/>{label}</label>)}</div><button disabled={Boolean(busy)} onClick={()=>void readable()}>生成资料预览</button>{html&&<><iframe className="family-export-frame" sandbox="" title="资料导出预览" srcDoc={html}/><a className="family-file-link" href={htmlUrl} download={`headup-records-${localDate()}.html`}>保存这份HTML资料包</a><p>核对内容后，再由你决定如何使用。此资料包不能代替可恢复的加密备份。</p></>}</section>
    {busy&&<p role="status">{busy==='restore'?'正在原子写入本机，请稍候…':'正在处理，请保留当前页面…'}{(busy==='inspect'||busy.startsWith('part-'))&&<button onClick={()=>controller.current?.abort()}>取消当前处理</button>}</p>}{message&&<p className="family-notice" role="status">{message}</p>}
  </div>
}
