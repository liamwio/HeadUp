import {createServer} from 'node:http'
import {FamilyDatabase} from './familyDb.ts'
import {createFamilyHandler} from './familyApi.ts'
import {CLOUD_CONSENT_VERSION} from '../src/family/cloudContract.ts'
if(process.env.HEADUP_QA!=='1')throw new Error('Only run this isolated fixture with HEADUP_QA=1')
let clockOffset=0
const db=new FamilyDatabase(':memory:',()=>Date.now()+clockOffset)
const parent=(await db.register('qa-parent','engineering-only-password','工程家长')).user
await db.register('qa-child','engineering-only-password','工程孩子')
const family=db.createFamily(parent,'隔离验收家庭'),now=new Date().toISOString()
db.createProfile(parent,family.id,{id:'qa-profile',nickname:'合成档案',purpose:'只验证权限，不含真实个人照片',preferredSide:null,createdAt:now,updatedAt:now,consent:{version:'LOCAL-FAMILY-1',guardianConfirmed:true,childInformed:true,storage:true,at:now}},CLOUD_CONSENT_VERSION)
const handler=createFamilyHandler(db,{HEADUP_APP_ORIGINS:'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5190,http://localhost:5190',HEADUP_REGISTRATION_CODE:'qa-only-registration'},'headup_qa_session')
let offline=false
const server=createServer((req,res)=>{
  if(req.method==='POST'&&req.headers['x-headup-qa']==='local-test'&&['/_qa/network/offline','/_qa/network/online'].includes(req.url??'')){offline=req.url!.endsWith('/offline');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({offline}));return}
  if(req.method==='POST'&&req.headers['x-headup-qa']==='local-test'&&req.url==='/_qa/time/advance-hour'){clockOffset+=3600000;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({clockOffset}));return}
  if(offline){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"offline","message":"模拟网络中断，本机内容仍保留"}');return}
  void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end()}})
})
server.on('close',()=>db.close());server.listen(5196,'127.0.0.1',()=>console.log('Isolated in-memory family QA service ready on 5196; no production accounts or data.'))
