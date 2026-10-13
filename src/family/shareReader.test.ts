import {afterEach,it,expect,vi} from 'vitest'
import {createShareReader,SHARE_VIEW_LEASE_MS,SHARE_RECHECK_MS,type ShareReaderIdentity,type ShareReaderState} from './shareReader'
import {SyncError} from './cloudTransport'
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const response=(options:{expiresAt?:number;serverNow?:number;note?:string}={})=>({id:'shared-id',createdAt:100,expiresAt:options.expiresAt??1000000,serverNow:options.serverNow??1000,content:{schema:'HEADUP-SHARED-CONTENT-1',range:{from:'',to:''},boundary:'工程边界',sessions:[{ref:'R1',date:'2026-09-20',kind:'memory',photos:[],readings:[],note:options.note??'所选内容'}],events:[]}})
function auth(name='receiver',read:(signal?:AbortSignal)=>Promise<unknown>=async()=>response()):ShareReaderIdentity{const me={user:{id:name,username:name,displayName:name},csrf:'engineering-csrf',families:[]};return{me,transport:{authenticate:vi.fn(async()=>me),request:vi.fn(async(_path,_method,_body,_headers,signal)=>read(signal))}}}
const readers:Array<ReturnType<typeof createShareReader>>=[]
afterEach(()=>{readers.splice(0).forEach(r=>r.dispose());vi.useRealTimers()})
function setup(identify:(signal:AbortSignal)=>Promise<ShareReaderIdentity>,extra:Partial<Parameters<typeof createShareReader>[0]>={}){const states:ShareReaderState[]=[];const reader=createShareReader({token:'A'.repeat(43),identify,onState:s=>states.push(s),now:()=>0,...extra});readers.push(reader);return{reader,states,last:()=>states.at(-1)!}}
it('does not cache or use an old identity that arrives after an account switch',async()=>{
  const old=deferred<ShareReaderIdentity>(),oldAuth=auth('old'),fresh=auth('new'),identify=vi.fn().mockImplementationOnce(()=>old.promise).mockResolvedValue(fresh),x=setup(identify)
  const pending=x.reader.refresh();x.reader.invalidate('账号已切换');await x.reader.refresh();expect(x.last().auth?.me.user.id).toBe('new');old.resolve(oldAuth);await pending;expect(oldAuth.transport.authenticate).not.toHaveBeenCalled();await x.reader.refresh();expect(x.last().auth?.me.user.id).toBe('new');expect(identify).toHaveBeenCalledTimes(2)
})
it('cannot repopulate content from an aborted response even if the transport ignores cancellation',async()=>{
  const reply=deferred<unknown>(),entered=deferred<void>();let requestSignal:AbortSignal|undefined;const x=setup(async()=>auth('reader',signal=>{requestSignal=signal;entered.resolve();return reply.promise}))
  const pending=x.reader.refresh();await entered.promise;x.reader.invalidate('离线');expect(requestSignal?.aborted).toBe(true);reply.resolve(response());await pending;expect(x.last().view).toBeNull();expect(x.last().auth).toBeNull();expect(x.last().error).toBe('离线')
})
it('deduplicates concurrent refresh attempts',async()=>{
  const reply=deferred<unknown>(),entered=deferred<void>(),identity=auth('reader',()=>{entered.resolve();return reply.promise}),x=setup(async()=>identity)
  const first=x.reader.refresh();await entered.promise;await x.reader.refresh();expect(identity.transport.request).toHaveBeenCalledTimes(1);reply.resolve(response());await first;expect(x.last().view?.id).toBe('shared-id')
})
it('ends a stalled initial identity check without allowing its late result to start a data request',async()=>{
  vi.useFakeTimers();const result=deferred<ShareReaderIdentity>(),identity=auth(),x=setup(()=>result.promise);const pending=x.reader.refresh();await vi.advanceTimersByTimeAsync(SHARE_VIEW_LEASE_MS);expect(x.last()).toMatchObject({view:null,auth:null,busy:false});expect(x.last().error).toContain('停止等待');result.resolve(identity);await pending;expect(identity.transport.request).not.toHaveBeenCalled()
})
it('counts slow verification time against the display lease instead of extending it',async()=>{
  vi.useFakeTimers();let monotonic=0;const x=setup(async()=>auth('reader',async()=>{monotonic=10000;return response()}),{now:()=>monotonic});await x.reader.refresh();await vi.advanceTimersByTimeAsync(SHARE_VIEW_LEASE_MS-10001);expect(x.last().view).not.toBeNull();await vi.advanceTimersByTimeAsync(1);expect(x.last().view).toBeNull()
})
it('clears previously verified content at the short lease deadline while a later check is hung',async()=>{
  vi.useFakeTimers();const reply=deferred<unknown>(),identity=auth(),request=vi.mocked(identity.transport.request);request.mockResolvedValueOnce(response()).mockImplementation(()=>reply.promise)
  const x=setup(async()=>identity);x.reader.start();await vi.advanceTimersByTimeAsync(0);expect(x.last().view).not.toBeNull();await vi.advanceTimersByTimeAsync(SHARE_RECHECK_MS);expect(x.last().busy).toBe(true);await vi.advanceTimersByTimeAsync(SHARE_VIEW_LEASE_MS-SHARE_RECHECK_MS);expect(x.last().view).toBeNull();expect(x.last().auth).toBeNull();x.reader.dispose();reply.resolve(response());await Promise.resolve();expect(x.last().view).toBeNull()
})
it('uses server time and request duration, so local wall-clock changes cannot extend expiry',async()=>{
  vi.useFakeTimers();let monotonic=100;const identity=auth('reader',async()=>{monotonic=400;return response({serverNow:10000,expiresAt:11000})}),x=setup(async()=>identity,{now:()=>monotonic})
  await x.reader.refresh();vi.setSystemTime(new Date('2000-01-01'));await vi.advanceTimersByTimeAsync(699);expect(x.last().view).not.toBeNull();await vi.advanceTimersByTimeAsync(1);expect(x.last().view).toBeNull()
})
it('clears visible content and asks for login after a lost session',async()=>{
  const identity=auth(),x=setup(async()=>identity);await x.reader.refresh();vi.mocked(identity.transport.authenticate).mockRejectedValueOnce(new SyncError('login_required','请登录',401));await x.reader.refresh();expect(x.last()).toMatchObject({view:null,auth:null,busy:false,needsLogin:true})
})
it('refuses a changed frozen view instead of replacing the user-visible snapshot',async()=>{
  const identity=auth(),x=setup(async()=>identity);await x.reader.refresh();vi.mocked(identity.transport.request).mockResolvedValueOnce(response({note:'不同的内容'}));await x.reader.refresh();expect(x.last().view).toBeNull();expect(x.last().error).toContain('分享内容已改变')
})
it('does not load while hidden and does not publish or use a late identity after disposal',async()=>{
  vi.useFakeTimers();let visible=false;const result=deferred<ShareReaderIdentity>(),identity=auth(),identify=vi.fn(()=>result.promise),x=setup(identify,{isVisible:()=>visible});x.reader.start();await vi.advanceTimersByTimeAsync(0);expect(identify).not.toHaveBeenCalled();visible=true;const pending=x.reader.refresh();x.reader.dispose();const length=x.states.length;result.resolve(identity);await pending;await vi.advanceTimersByTimeAsync(60000);expect(x.states).toHaveLength(length);expect(identity.transport.authenticate).not.toHaveBeenCalled()
})
