import {afterEach,expect,it,vi} from 'vitest'
import {configureLogoutNamespace,rememberLogout,flushPendingLogout} from './pendingLogout'
afterEach(()=>vi.unstubAllGlobals())
it('retains offline logout requests and does not discard a newer request when an earlier response arrives',async()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)})
  configureLogoutNamespace('queue-test');rememberLogout('old-user','a'.repeat(64),'/api/family')
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));await expect(flushPendingLogout()).rejects.toThrow('offline');expect(values.size).toBe(1)
  let finish!:(r:Response)=>void;const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>finish=r)).mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch',fetcher);const pending=flushPendingLogout();rememberLogout('new-user','b'.repeat(64),'/api/family');finish(new Response('{}'));await pending
  expect(JSON.parse([...values.values()][0])).toEqual([{userId:'new-user',proof:'b'.repeat(64),base:'/api/family'}])
  await flushPendingLogout();expect(values.size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(2)
})
