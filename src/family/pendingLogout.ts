let key='headup-cloud-pending-logout'
export function configureLogoutNamespace(suffix:string){key='headup-cloud-pending-logout:'+suffix}
export function rememberLogout(userId:string,proof:string,base:string){const items=read();if(!items.some(i=>i.userId===userId&&i.proof===proof&&i.base===base))items.push({userId,proof,base});localStorage.setItem(key,JSON.stringify(items))}
type Pending={userId:string;proof:string;base:string}
function read():Pending[]{try{const value=JSON.parse(localStorage.getItem(key)??'null');return (Array.isArray(value)?value:value?[value]:[]).filter(item=>typeof item.userId==='string'&&typeof item.proof==='string'&&/^[a-f0-9]{64}$/.test(item.proof)&&typeof item.base==='string'&&/^\/[a-zA-Z0-9/_-]+$/.test(item.base)&&!item.base.startsWith('//'))}catch{return []}}
export async function flushPendingLogout(){
  const namespace=key
  for(const item of read()){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000)
  try{const response=await fetch(item.base+'/auth/logout-proof',{method:'POST',redirect:'error',cache:'no-store',credentials:'same-origin',signal:abort.signal,headers:{'Content-Type':'application/json','X-HeadUp-Request':'1'},body:JSON.stringify({userId:item.userId,proof:item.proof})});if(!response.ok)throw new Error('服务器退出尚未完成，请联网后重试');if(key===namespace){const remaining=read().filter(i=>i.userId!==item.userId||i.proof!==item.proof||i.base!==item.base);if(remaining.length)localStorage.setItem(key,JSON.stringify(remaining));else localStorage.removeItem(key)}}finally{clearTimeout(timer)}
  }
}
