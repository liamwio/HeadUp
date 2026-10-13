import {registerPlugin} from '@capacitor/core'
import {writeNativeFile,type NativeFileWriter} from './exportFile'
const Device=registerPlugin<NativeFileWriter>('HeadUpDevice')
export function installNativeDownloads(){
  const click=HTMLAnchorElement.prototype.click;let busy=false
  const eligible=(a:HTMLAnchorElement)=>Boolean(a.download)&&/^(blob:|data:)/.test(a.href)
  const save=async(a:HTMLAnchorElement)=>{
    if(busy)return;busy=true;const status=document.createElement('div');status.className='native-export-status';status.setAttribute('role','status');status.textContent='正在准备保存文件…';document.body.append(status)
    try{const response=await fetch(a.href),blob=await response.blob();await writeNativeFile(Device,blob,a.download,percent=>{status.textContent=`正在保存文件… ${percent}%`});status.textContent='文件已保存到你选择的位置。'}
    catch(e){status.textContent=e instanceof Error?e.message:'文件未保存，请重试'}finally{busy=false;const close=document.createElement('button');close.textContent='知道了';close.onclick=()=>status.remove();status.append(close)}
  }
  HTMLAnchorElement.prototype.click=function(){if(eligible(this)){void save(this);return}click.call(this)}
  document.addEventListener('click',event=>{const a=(event.target as Element|null)?.closest?.('a');if(a instanceof HTMLAnchorElement&&eligible(a)){event.preventDefault();event.stopImmediatePropagation();void save(a)}},true)
}
