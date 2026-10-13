(function(){
  if(window.__headupNativeDownloadInstalled||!window.HeadUpExport)return;
  window.__headupNativeDownloadInstalled=true;
  const bridge=window.HeadUpExport,pending=new Map();let busy=false,serial=0;
  bridge.onmessage=function(event){try{const message=JSON.parse(event.data),item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(new Error(message.error)):item.resolve(message.result)}catch{}};
  const request=(action,data={})=>new Promise((resolve,reject)=>{const id=String(++serial);pending.set(id,{resolve,reject});bridge.postMessage(JSON.stringify({id,action,...data}))});
  const eligible=a=>Boolean(a.download)&&/^(blob:|data:)/.test(a.href);
  const save=async a=>{
    if(busy)return;busy=true;let token;const status=document.createElement('div');status.setAttribute('role','status');Object.assign(status.style,{position:'fixed',bottom:'12px',left:'12px',right:'12px',zIndex:2147483647,background:'#fffaf8',color:'#29252a',padding:'18px',border:'1px solid #782d3e',borderRadius:'12px',font:'14px system-ui'});status.textContent='正在准备文件…';document.body.append(status);
    try{const blob=await(await fetch(a.href)).blob();if(blob.size>64*1024*1024)throw new Error('本次文件超过64MB，请使用分卷备份或缩小范围');token=(await request('begin',{name:a.download||'headup-export',mime:blob.type||'application/octet-stream',size:blob.size})).token;
      for(let start=0;start<blob.size;start+=192*1024){const bytes=new Uint8Array(await blob.slice(start,start+192*1024).arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));await request('append',{token,data:btoa(raw)});status.textContent='正在保存… '+Math.min(100,Math.round((start+bytes.length)/blob.size*100))+'%'}
      await request('finish',{token});token=undefined;status.textContent='文件已保存到你选择的位置。';
    }catch(error){if(token)await request('abort',{token}).catch(()=>{});status.textContent=error.message||'文件未保存，请重试。'}finally{busy=false;const close=document.createElement('button');close.textContent='知道了';close.style.minHeight='44px';close.onclick=()=>status.remove();status.append(close)}
  };
  const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(eligible(this)){void save(this);return}click.call(this)};
  document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(a&&eligible(a)){event.preventDefault();event.stopImmediatePropagation();void save(a)}},true);
})();
