import {afterEach,it,expect,vi} from 'vitest'
import {createServer,type Server} from 'node:http'
import {aiConfiguration,createAiHandler} from './aiService.ts'
import {AI_CONTRACT_VERSION,AI_CONSENT_VERSION,localAiSelection,type AiInput} from '../src/family/aiContract.ts'
const input:AiInput={version:AI_CONTRACT_VERSION,topic:'overview',focus:null,records:[{ref:'R1',date:'2026-09-17',kind:'memory',measuredCount:0,previous:null,metrics:[],versions:{algorithm:'A1',norm:'N1',copy:'C1',protocol:'P1'},views:[{view:'front',side:'unknown',quality:'pass',pose:'pass'}]}]}
const selection={recorded:['record-count'],observed:['R1-reading'],limitations:['boundary'],actions:['schedule']}
const env={HEADUP_AI_ENDPOINT:'https://provider.example/v1/chat/completions',HEADUP_AI_MODEL:'test-model',HEADUP_AI_API_KEY:'test-secret',HEADUP_APP_ORIGINS:'http://127.0.0.1:5190'}
const servers:Server[]=[]
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>{s.close(()=>r());s.closeAllConnections()})))})
async function start(fetcher:typeof fetch,config=env,timeoutMs=1000,authenticate?:()=>boolean){const handler=createAiHandler({env:config,fetcher,timeoutMs,authenticate}),s=createServer((q,r)=>void handler(q,r));servers.push(s);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(s.address() as {port:number}).port}`}
function post(url:string,body:unknown={consentVersion:AI_CONSENT_VERSION,configId:aiConfiguration(env).configId,input},origin='http://127.0.0.1:5190'){return fetch(url+'/api/ai/stage',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-HeadUp-Request':'1'},body:JSON.stringify(body)})}
const valid=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(selection)}}]}))
it('does not expose secrets in config; sends only validated evidence to configured provider',async()=>{
  const provider=vi.fn<typeof fetch>().mockResolvedValue(valid()),url=await start(provider)
  const config=await (await fetch(url+'/api/ai/config')).json();expect(JSON.stringify(config)).not.toContain('test-secret');expect(config.ready).toBe(true)
  const response=await post(url);expect(response.status).toBe(200);expect((await response.json()).selection).toEqual(selection)
  const args=provider.mock.calls[0];expect(args[0]).toBe(env.HEADUP_AI_ENDPOINT);expect(args[1]?.redirect).toBe('error')
  const payload=JSON.parse(args[1]?.body as string);expect(payload.store).toBe(false);expect(payload.messages[1].content).not.toContain('profileId');expect(payload.messages[1].content).toContain('record-count')
})
it('carries measured numbers and their bounds through real HTTP and rejects selectively omitted uncertainty',async()=>{
  const measured:AiInput={...input,topic:'uncertainty',focus:{ref:'R1',code:'FRONT-RATIO-07'},records:[{...input.records[0],kind:'measurement',measuredCount:1,metrics:[{code:'FRONT-RATIO-07',values:[40.71],uncertainty:[5.88],origin:'measurement'}]}]}
  const answer=localAiSelection(measured),provider=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}))),url=await start(provider)
  const body={consentVersion:AI_CONSENT_VERSION,configId:aiConfiguration(env).configId,input:measured}
  expect((await post(url,body)).status).toBe(200)
  const evidence=JSON.parse(String(provider.mock.calls[0][1]?.body)).messages[1].content;expect(evidence).toContain('40.71% ± 5.88 个百分点');expect(evidence).toContain('不是个人的生理正常范围');expect(evidence).not.toContain('landmarks')
  provider.mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...answer,limitations:['boundary']})}}]})))
  expect(await(await post(url,body)).json()).toEqual({error:'unverified_output'})
})
it('requires consent, current configuration, allowed origin and no extra data before any API call',async()=>{
  const provider=vi.fn<typeof fetch>(),url=await start(provider),base={consentVersion:AI_CONSENT_VERSION,configId:aiConfiguration(env).configId,input}
  for(const body of [{...base,consentVersion:''},{...base,configId:'old'},{...base,photo:'secret'},{...base,input:{...input,nickname:'private'}}])expect((await post(url,body)).status).toBe(400)
  expect((await post(url,base,'https://other.example')).status).toBe(403);expect(provider).not.toHaveBeenCalled()
})
it('handles missing configuration without contacting provider',async()=>{const provider=vi.fn<typeof fetch>(),url=await start(provider,{...env,HEADUP_AI_API_KEY:''});expect((await post(url)).status).toBe(503);expect(provider).not.toHaveBeenCalled()})
it('rejects invalid provider output and does not echo its contents',async()=>{const provider=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...selection,text:'private/provider-error'})}}]}))),url=await start(provider),r=await post(url);expect(r.status).toBe(502);expect(await r.json()).toEqual({error:'unverified_output'})})
it('aborts a stalled provider request',async()=>{const provider=vi.fn<typeof fetch>().mockImplementation((_u,o)=>new Promise((_r,reject)=>o?.signal?.addEventListener('abort',()=>reject(new Error('abort'))))),url=await start(provider,env,20);expect(await (await post(url)).json()).toEqual({error:'timeout'})})
it('rejects insecure or credential-bearing endpoints',()=>{for(const url of ['http://provider.example/chat','https://user:pass@provider.example/chat','https://provider.example/chat?key=x'])expect(aiConfiguration({...env,HEADUP_AI_ENDPOINT:url}).ready).toBe(false)})

it('requires account authentication when the deployment enables it',async()=>{let allowed=false;const provider=vi.fn<typeof fetch>().mockResolvedValue(valid()),url=await start(provider,env,1000,()=>allowed);expect((await(await fetch(url+'/api/ai/config')).json()).requiresLogin).toBe(true);expect((await post(url)).status).toBe(401);expect(provider).not.toHaveBeenCalled();allowed=true;expect((await post(url)).status).toBe(200)})
