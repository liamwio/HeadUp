import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import FamilyApp from '../family/FamilyApp'
import '../appStyles'
import '../android/native.css'
import {installNativeDownloads} from '../android/nativeDownloads'
const originalFetch=window.fetch.bind(window)
window.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.href)
  if(url.origin===location.origin&&url.pathname.startsWith('/api/')){
    if(url.pathname==='/api/ai/config')return new Response(JSON.stringify({ready:false,provider:'iOS本机模式',model:'',configId:'ios-local',contract:'HEADUP-STAGE-2',requiresLogin:false}),{headers:{'Content-Type':'application/json'}})
    return new Response(JSON.stringify({error:'native_local_mode',message:'当前为个人本机模式，家庭服务已关闭。'}),{status:503,headers:{'Content-Type':'application/json'}})
  }
  return originalFetch(input,init)
}
installNativeDownloads()
function IOSApp(){return <FamilyApp/>}
createRoot(document.getElementById('root')!).render(<StrictMode><IOSApp/></StrictMode>)
