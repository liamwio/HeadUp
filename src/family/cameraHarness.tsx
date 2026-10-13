import {DEFAULT_CAMERA_OPTIONS} from '../lib/cameraFeedback'
import {useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {LiveCapture,type CameraDependencies} from '../LiveCapture'
import {readCapture,readImageWithoutModels} from '../lib/readCapture'
import {RecordFlow} from './RecordFlow'
import {createProfile,type FamilyProfile} from './model'
import {FamilyStore,configureLocalFamilyStore} from './store'
import '../appStyles'
import './family.css'
const qaStore=new FamilyStore('headup-camera-guided-qa-13',true)
configureLocalFamilyStore(qaStore)
const noop=()=>{}

function CameraHarness(){
  const [guided,setGuided]=useState<FamilyProfile|null>(null)
  const [mode,setMode]=useState<'auto'|'offline'|'denied'|'late'|'coach'|null>(null),[result,setResult]=useState('待运行'),[photo,setPhoto]=useState(''),[refresh,setRefresh]=useState(0)
  const [scenario,setScenario]=useState('good'),[coachOptions,setCoachOptions]=useState({...DEFAULT_CAMERA_OPTIONS,auto:false})
  const streams=useRef<MediaStream[]>([]),photoUrl=useRef(''),late=useRef<(()=>void)|null>(null)
  const liveCount=()=>streams.current.reduce((n,s)=>n+s.getTracks().filter(t=>t.readyState==='live').length,0)
  const album=(file:File,mirror:boolean)=>{setMode(null);if(photoUrl.current)URL.revokeObjectURL(photoUrl.current);photoUrl.current=URL.createObjectURL(file);setPhoto(photoUrl.current);setResult(`已选择相册 ${file.name} · 镜像 ${mirror} · 当前存活轨道 ${liveCount()}`)}
  const runtime=useMemo<CameraDependencies>(()=>({getMedia:async c=>{
    if(c.audio!==false)throw new Error('audio_requested')
    if(mode==='denied')throw new DOMException('fixture','NotAllowedError')
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=1000
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#efe4d5';ctx.fillRect(0,0,800,1000);ctx.fillStyle='#782d3e';ctx.font='38px sans-serif';ctx.fillText('合成相机画面 · 非人物',120,450)
    const stream=canvas.captureStream(10);streams.current.push(stream)
    const timer=setInterval(()=>{if(stream.getTracks().every(t=>t.readyState==='ended')){clearInterval(timer);return}ctx.fillRect(100,700,20,20)},80)
    if(mode==='late')await new Promise<void>(resolve=>{late.current=resolve})
    return stream
  },inspect:async(_id,_bitmap,stage)=>{if(mode==='offline')throw new Error('model_offline');return{quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:scenario==='dark'?['光线不足']:scenario==='capture_bad'&&stage==='captured'?['画面模糊']:[]},pose:{status:scenario==='tilt'?'reject':'pass',roll:scenario==='tilt'?23.1:0,yaw:scenario==='tilt'?80:0,pitch:0,estimatedPose:scenario==='left'||scenario==='tilt'?'left_profile':scenario==='right'?'right_profile':'front',detectedFaces:1,flags:scenario==='tilt'?['头部横向倾斜过大']:[],faceBounds:scenario==='far'?{x:.42,y:.37,width:.16,height:.26}:scenario==='edge'?{x:.29,y:.02,width:.42,height:.5}:scenario==='offset'?{x:.13,y:.25,width:.3,height:.5}:{x:.29,y:.25,width:.42,height:.5}}}}}),[mode,scenario])
  if(guided)return <div className="family-app" style={{padding:16}}><p>隔离拍摄流程验收：合成相机、真实选图检测、独立工程存储；请勿录入家庭私人照片。</p><RecordFlow cameraRuntime={runtime} profile={guided} receivingHandoff onAccount={noop} onHandoffOpen={noop} onBusy={noop} onDirty={noop} onPrivacy={noop} onExit={()=>{setGuided(null);setMode(null)}} onSaved={session=>{setGuided(null);setMode(null);setResult(`完整流程已保存 ${session.id} · ${session.captures.map(c=>c.id+':'+c.source).join(' / ')} · 方法 ${session.protocol.method} · 当前存活轨道 ${liveCount()}`)}}/></div>
  return <main style={{maxWidth:900,margin:'30px auto',padding:24}}><h1>相机隔离自测</h1><p>只使用canvas合成媒体流，不请求真实摄像头、不访问家庭档案。姿态结果为固定测试输入，不验证真人模型精度。</p><label>智能提示场景<select value={scenario} onChange={e=>setScenario(e.target.value)}><option value="good">正面合适</option><option value="far">距离偏远</option><option value="edge">顶部贴边</option><option value="offset">位置偏左</option><option value="dark">光线不足</option><option value="tilt">侧面倾斜估计待核对</option><option value="capture_bad">预览合格、拍后模糊</option><option value="left">左侧面</option><option value="right">右侧面</option></select></label><div className="family-actions"><button onClick={()=>setMode('coach')}>查看智能取景</button><button onClick={async()=>{const profile=createProfile({nickname:'拍摄流程工程档案',preferredSide:'left_profile',guardianConfirmed:true,childInformed:true,storage:true});await qaStore.putProfile(profile);setMode('offline');setGuided(profile)}}>启动完整正侧面流程</button>{(['auto','offline','denied','late'] as const).map(m=><button key={m} onClick={()=>{setResult('运行中');setMode(m)}}>{{auto:'启动自动拍摄测试',offline:'模型失败手动拍摄',denied:'模拟权限拒绝',late:'模拟迟到权限'}[m]}</button>)}<button onClick={()=>{late.current?.();late.current=null;setRefresh(n=>n+1)}}>返回迟到的媒体流</button><button onClick={()=>{setRefresh(n=>n+1);setResult(`当前存活轨道：${liveCount()}`)}}>检查媒体释放</button></div><p role="status">{result}</p><p>媒体流累计：{streams.current.length} · 当前存活轨道：{liveCount()} · 检查次数：{refresh}</p>{photo&&<img src={photo} alt="隔离验收中选择或拍摄的照片" style={{maxHeight:300}}/>}{mode&&<LiveCapture onAlbum={album} id={scenario==='left'||scenario==='right'||scenario==='tilt'?'profile':'front'} preferredSide={scenario==='left'||scenario==='tilt'?'left_profile':scenario==='right'?'right_profile':undefined} options={mode==='coach'?coachOptions:undefined} onOptionsChange={mode==='coach'?setCoachOptions:undefined} profileName="隔离自测" runtime={runtime} onClose={()=>{setMode(null);setResult('已关闭相机')}} onCapture={async(file,meta)=>{setMode(null);if(photoUrl.current)URL.revokeObjectURL(photoUrl.current);photoUrl.current=URL.createObjectURL(file);setPhoto(photoUrl.current);const image=await createImageBitmap(file),dimensions=`${image.width}×${image.height}`;image.close();const kept=await readCapture('front',file,true,{prepare:async()=>{throw new Error('offline')},read:readImageWithoutModels,timeoutMs:100});setResult(`已拍摄 ${dimensions} · 来源 ${meta.source} · 采集${meta.captureSelection?.frames??1}帧、只保留1张 · 模型失败后保留照片 ${kept.file===file&&Boolean(kept.analysisError)} · 当前存活轨道 ${liveCount()}`)}}/>}</main>
}
createRoot(document.getElementById('root')!).render(<CameraHarness/> )
