import {spawn,spawnSync} from 'node:child_process'
import {existsSync,mkdirSync,openSync,closeSync,writeFileSync,statSync,readdirSync} from 'node:fs'
import {createServer} from 'node:net'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const args=new Set(process.argv.slice(2)),envArgs=['--env-file-if-exists=.env.ai.local','--env-file-if-exists=.env.family.local']
const delay=ms=>new Promise(done=>setTimeout(done,ms))
function runNode(args){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.error||result.status!==0)throw new Error('命令未完成，请根据上方错误处理后重试。')}
function newest(path){if(!existsSync(path))return 0;const info=statSync(path);if(!info.isDirectory())return info.mtimeMs;let time=info.mtimeMs;for(const entry of readdirSync(path,{withFileTypes:true})){if(entry.isSymbolicLink())continue;time=Math.max(time,newest(join(path,entry.name)))}return time}
function needsBuild(){const index=join(root,'dist/index.html');if(!existsSync(index))return true;const built=statSync(index).mtimeMs;return ['src','public','index.html','package.json','pnpm-lock.yaml','vite.config.ts','tsconfig.json','tsconfig.app.json','tsconfig.node.json'].some(path=>newest(join(root,path))>built)}
async function isHeadUp(url){try{const response=await fetch(url+'api/ai/config',{signal:AbortSignal.timeout(1500),redirect:'error'});if(!response.ok)return false;const config=await response.json();return config.contract==='HEADUP-STAGE-2'&&typeof config.ready==='boolean'}catch{return false}}
async function isAppReady(url){if(!await isHeadUp(url))return false;try{const response=await fetch(url,{signal:AbortSignal.timeout(1500),redirect:'error'});const ready=response.ok&&response.headers.get('content-type')?.includes('text/html');await response.body?.cancel();return Boolean(ready)}catch{return false}}
async function portAvailable(port){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)))})}

async function main(){
  if(args.has('--help')){console.log('用法：node scripts/start-headup.mjs [--rebuild]\n双击项目根目录“启动服务.cmd”也可运行。已有 HeadUp 服务会复用；缺少或更新过的前端会自动构建。');return}
  for(const arg of args)if(!['--rebuild','--no-pause'].includes(arg))throw new Error('未知参数：'+arg+'；可使用 --help 查看用法。')
  const [major,minor]=process.versions.node.split('.').map(Number)
  if(major<24||major===24&&minor<12)throw new Error('请使用 Node.js 24.12 或更新版本；当前为 '+process.versions.node)
  for(const path of ['node_modules/typescript/bin/tsc','node_modules/vite/bin/vite.js'])if(!existsSync(join(root,path)))throw new Error('缺少项目依赖。请先在项目目录运行 pnpm install --frozen-lockfile，然后重试。')
  const config=spawnSync(process.execPath,[...envArgs,'--input-type=module','-e',"const p=Number(process.env.HEADUP_API_PORT??5191);if(!Number.isInteger(p)||p<1||p>65535)process.exit(2);process.stdout.write(String(p))"],{cwd:root,encoding:'utf8',windowsHide:true})
  if(config.status!==0||!/^\d+$/.test(config.stdout??''))throw new Error('无法读取启动配置。请检查 .env.ai.local、.env.family.local 和 HEADUP_API_PORT（1–65535）。')
  const port=Number(config.stdout),url=`http://127.0.0.1:${port}/`,existing=await isHeadUp(url)
  if(!existing&&!await portAvailable(port))throw new Error(`端口 ${port} 已被其他程序占用，未结束任何进程。请检查端口或修改 HEADUP_API_PORT。`)
  if(args.has('--rebuild')||needsBuild()){
    console.log('正在检查并构建前端，请稍候…')
    runNode(['node_modules/typescript/bin/tsc','-b','--pretty','false'])
    runNode(['node_modules/vite/bin/vite.js','build'])
  }
  if(existing){if(!await isAppReady(url))throw new Error('HeadUp 后端已运行，但网页尚不可用。请运行本脚本加 --rebuild 参数重新构建。');console.log(`\n端口上已有 HeadUp 服务，已复用。\n打开：${url}\n如更改了后端代码或环境配置，需要重启原服务才能生效。`);return}
  const logDir=join(root,'.headup-server','run');mkdirSync(logDir,{recursive:true})
  const output=join(logDir,`server-${port}.log`),errors=join(logDir,`server-${port}.error.log`),state=join(logDir,`server-${port}.json`)
  const out=openSync(output,'a',0o600),err=openSync(errors,'a',0o600)
  let child
  try{child=spawn(process.execPath,[...envArgs,'--experimental-strip-types',join(root,'server/index.ts')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]})}finally{closeSync(out);closeSync(err)}
  let ended=false,launchError
  child.once('error',error=>{launchError=error;ended=true});child.once('exit',()=>{ended=true});child.unref()
  const info={pid:child.pid,port,url,root,startedAt:new Date().toISOString()}
  writeFileSync(state,JSON.stringify({...info,status:'starting'},null,2),{mode:0o600})
  console.log(`启动进程：${child.pid??'未创建'}\n日志：${output}\n错误日志：${errors}`)
  const deadline=Date.now()+20000
  while(Date.now()<deadline){
    if(await isAppReady(url)){
      // A concurrent launcher may have won the port; do not claim its process as ours.
      if(ended){console.log(`\n另一个 HeadUp 实例已就绪。打开：${url}`);return}
      writeFileSync(state,JSON.stringify({...info,status:'running'},null,2),{mode:0o600})
      console.log(`\nHeadUp 服务已就绪。\n打开：${url}\n服务在后台运行，关闭此启动窗口不会停止服务。`);return
    }
    if(ended)throw new Error(`服务启动失败${launchError?.code?'（'+launchError.code+'）':''}。请查看错误日志：${errors}`)
    await delay(500)
  }
  throw new Error(`暂未确认服务就绪，进程可能仍在初始化，未自动结束它。请查看日志后再试：${errors}`)
}
main().catch(error=>{console.error('\n启动未完成：'+error.message);process.exitCode=1})
