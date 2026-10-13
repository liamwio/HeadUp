import {it,expect,vi} from 'vitest'
import {createSharePhotoQueue,createSharePhotoResource} from './sharePhotos'
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
const blob=new Blob(['engineering'],{type:'image/png'})
it('bounds concurrent reads even after rapidly canceled pages whose transport ignores abort',async()=>{
  const pending=new Map<string,ReturnType<typeof deferred<Blob>>>();let running=0,max=0
  const loader=vi.fn((ref:string)=>{running++;max=Math.max(max,running);const item=deferred<Blob>();pending.set(ref,item);return item.promise.finally(()=>{running--})}),queue=createSharePhotoQueue(loader),a=new AbortController(),b=new AbortController(),c=new AbortController()
  const first=queue.load('old-a',a.signal).catch(e=>e),second=queue.load('old-b',b.signal),third=queue.load('new-page',c.signal);await flush();expect(loader).toHaveBeenCalledTimes(2)
  a.abort();expect((await first).name).toBe('AbortError');await flush();expect(loader).toHaveBeenCalledTimes(2)
  pending.get('old-a')!.resolve(blob);await flush();expect(loader).toHaveBeenCalledTimes(3);pending.get('old-b')!.resolve(blob);pending.get('new-page')!.resolve(blob);await Promise.all([second,third]);expect(max).toBe(2)
})
it('never starts canceled queued or already-aborted reads, and failures free their slot',async()=>{
  const work=deferred<Blob>(),loader=vi.fn().mockImplementationOnce(()=>work.promise).mockResolvedValue(blob),queue=createSharePhotoQueue(loader,1),a=new AbortController(),b=new AbortController(),c=new AbortController()
  const first=queue.load('active',a.signal).catch(e=>e),second=queue.load('queued',b.signal).catch(e=>e);await flush();b.abort();expect((await second).name).toBe('AbortError');c.abort();await expect(queue.load('never',c.signal)).rejects.toMatchObject({name:'AbortError'});work.reject(new Error('read failed'));await first;await flush();expect(loader).toHaveBeenCalledTimes(1);expect(await queue.load('next',new AbortController().signal)).toBe(blob)
})
it('does not create or publish an object URL when an old file check finishes after disposal',async()=>{
  const checked=deferred<void>(),entered=deferred<void>(),create=vi.fn(()=> 'blob:test'),onUrl=vi.fn(),onFailure=vi.fn();let signal:AbortSignal|undefined
  const resource=createSharePhotoResource({ref:'R1-front-original',load:async(_ref,s)=>{signal=s;return blob},check:()=>{entered.resolve();return checked.promise},onUrl,onFailure,urls:{create,revoke:vi.fn()}})
  await entered.promise;resource.dispose();checked.resolve();await flush();expect(signal?.aborted).toBe(true);expect(create).not.toHaveBeenCalled();expect(onUrl).not.toHaveBeenCalled();expect(onFailure).not.toHaveBeenCalled()
})
it('revokes a displayed URL exactly once and never starts a resource disposed before its first task',async()=>{
  const ready=deferred<void>(),create=vi.fn(()=> 'blob:owned'),revoke=vi.fn(),load=vi.fn(async()=>blob),resource=createSharePhotoResource({ref:'R1',load,check:async()=>{},onUrl:()=>ready.resolve(),onFailure:vi.fn(),urls:{create,revoke}})
  await ready.promise;resource.dispose();resource.dispose();expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned')
  const unopened=createSharePhotoResource({ref:'R2',load,check:async()=>{},onUrl:vi.fn(),onFailure:vi.fn(),urls:{create,revoke}});unopened.dispose();await flush();expect(load).toHaveBeenCalledTimes(1)
})
it('does not create a URL for invalid photo content',async()=>{
  const failed=deferred<Error>(),create=vi.fn(()=> 'blob:invalid'),resource=createSharePhotoResource({ref:'R1',load:async()=>blob,check:async()=>{throw new Error('invalid file')},onUrl:vi.fn(),onFailure:e=>failed.resolve(e),urls:{create,revoke:vi.fn()}})
  expect((await failed.promise).message).toBe('invalid file');expect(create).not.toHaveBeenCalled();resource.dispose()
})
it('keeps URL ownership bounded over many sequential photo groups and releases every group',async()=>{
  const queue=createSharePhotoQueue(async()=>blob),open=new Set<string>();let id=0,peak=0
  for(let page=0;page<30;page++){
    const ready=[deferred<void>(),deferred<void>()],resources=ready.map((completion,i)=>createSharePhotoResource({ref:`R${page}-${i}`,load:queue.load,check:async()=>{},onUrl:()=>completion.resolve(),onFailure:e=>completion.reject(e),urls:{create:()=>{const url='blob:'+ ++id;open.add(url);peak=Math.max(peak,open.size);return url},revoke:url=>{open.delete(url)}}}))
    await Promise.all(ready.map(r=>r.promise));expect(open.size).toBe(2);resources.forEach(r=>r.dispose());expect(open.size).toBe(0)
  }
  expect(id).toBe(60);expect(peak).toBe(2)
})
