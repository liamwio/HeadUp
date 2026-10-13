import {FAMILY_SERVICES_ENABLED} from '../src/productMode.ts'
import {createServer} from 'node:http'
import {createAiHandler} from './aiService.ts'
import {resolve,relative,isAbsolute} from 'node:path'
import {FamilyDatabase} from './familyDb.ts'
import {createFamilyHandler,authCookie} from './familyApi.ts'
import {staticApp} from './staticApp.ts'
import {apiPort} from './config.ts'
const port=apiPort()
const publicRoot=resolve('dist'),dataRoot=resolve(process.env.HEADUP_DATA_DIR??'.headup-server'),dataRelative=relative(publicRoot,dataRoot)
if(!isAbsolute(dataRelative)&&dataRelative!=='..'&&!dataRelative.startsWith('../')&&!dataRelative.startsWith('..\\'))throw new Error('家庭数据目录不能位于公开的dist目录内')
const db=!FAMILY_SERVICES_ENABLED||process.env.HEADUP_FAMILY_ENABLED==='0'?undefined:new FamilyDatabase(resolve(dataRoot,'family.sqlite'))
if(FAMILY_SERVICES_ENABLED&&process.env.HEADUP_COOKIE_SECURE==='1'&&!db)throw new Error('远程部署必须开启家庭身份服务')
const family=db?createFamilyHandler(db):undefined,ai=createAiHandler({authenticate:process.env.HEADUP_COOKIE_SECURE==='1'?req=>Boolean(db?.authenticate(authCookie(req))):undefined}),serve=staticApp(publicRoot)
const server=createServer((req,res)=>{void(async()=>{
  if(family&&await family(req,res))return
  if(req.url?.startsWith('/api/family/')){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ready":false,"error":"family_disabled"}');return}
  if(req.url?.startsWith('/api/ai/')){await ai(req,res);return}
  if(req.url?.startsWith('/api/')){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"not_found"}');return}
  await serve(req,res)
})().catch(()=>{if(res.destroyed)return;if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"internal_error"}')})})
server.requestTimeout=120000;server.headersTimeout=10000
const cleanup=setInterval(()=>{try{db?.cleanup()}catch{/* No request contents or database data are logged. */}},60000);cleanup.unref()
server.on('close',()=>{clearInterval(cleanup);db?.close()})
server.listen(port,'127.0.0.1',()=>console.log(`HeadUp app/API ready at http://127.0.0.1:${port}; no request contents logged`))
