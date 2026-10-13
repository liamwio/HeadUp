import {it,expect,vi} from 'vitest'
import {createShareActionGate} from './shareActionGate'
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
it('does not dispatch a mutation when the page leaves during authentication',async()=>{
  const gate=createShareActionGate(),auth=deferred<void>(),send=vi.fn(async()=>{}),error=vi.fn(),busy=vi.fn();let signal:AbortSignal|undefined
  const run=gate.run(()=>true,async a=>{await a.step(s=>{signal=s;return auth.promise});await a.step(send)},error,busy)
  gate.invalidate();expect(signal?.aborted).toBe(true);auth.resolve();expect(await run).toBe(false);expect(send).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled()
})
it('checks the live workspace even before an effect can invalidate the old action',async()=>{
  const gate=createShareActionGate(),read=deferred<void>(),persist=vi.fn(),send=vi.fn(async()=>{}),error=vi.fn();let valid=true
  const run=gate.run(()=>valid,async a=>{await a.step(()=>read.promise);persist();await a.step(send)},error,()=>{})
  valid=false;read.resolve();expect(await run).toBe(false);expect(persist).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled()
})
it('retains an unknown mutation result and never applies its late response to a new page',async()=>{
  const gate=createShareActionGate(),response=deferred<void>(),clear=vi.fn(),error=vi.fn(),busy=vi.fn();let pending=true
  const run=gate.run(()=>true,async a=>{await a.step(()=>response.promise);pending=false;clear()},error,busy)
  gate.invalidate();response.resolve();expect(await run).toBe(false);expect(pending).toBe(true);expect(clear).not.toHaveBeenCalled()
  expect(await gate.run(()=>true,async a=>{await a.step(async()=>{})},error,busy)).toBe(true)
})
it('ignores late failure/finalization without clearing a newer active action',async()=>{
  const gate=createShareActionGate(),old=deferred<void>(),next=deferred<void>(),error=vi.fn(),busy=vi.fn()
  const first=gate.run(()=>true,async a=>{await a.step(()=>old.promise)},error,busy);gate.invalidate()
  const second=gate.run(()=>true,async a=>{await a.step(()=>next.promise)},error,busy)
  old.reject(new Error('old'));await first;expect(busy.mock.calls).toEqual([[true],[true]]);expect(error).not.toHaveBeenCalled()
  next.resolve();expect(await second).toBe(true);expect(busy.mock.calls).toEqual([[true],[true],[false]])
})
it('rejects rapid duplicate actions and reports only an active request failure',async()=>{
  const gate=createShareActionGate(),pending=deferred<void>(),error=vi.fn(),duplicate=vi.fn(async()=>{}),busy=vi.fn()
  const first=gate.run(()=>true,async a=>{await a.step(()=>pending.promise)},error,busy)
  expect(await gate.run(()=>true,duplicate,error,busy)).toBe(false);expect(duplicate).not.toHaveBeenCalled()
  const problem=new Error('current');pending.reject(problem);await first;expect(error).toHaveBeenCalledExactlyOnceWith(problem);expect(busy.mock.calls).toEqual([[true],[false]])
})
