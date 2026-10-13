import { describe, expect, it } from 'vitest'
import { createUploadGate } from './uploadGate'
describe('capture upload ownership',()=>{
  it('allows only one model job at a time',()=>{
    const gate=createUploadGate(),token=gate.begin()!
    expect(gate.begin()).toBeNull();expect(gate.isCurrent(token)).toBe(true)
    expect(gate.finish(token)).toBe(true);expect(gate.begin()).not.toBeNull()
  })
  it('prevents a cancelled completion from changing a newer job',()=>{
    const gate=createUploadGate(),old=gate.begin()!
    gate.cancel();const current=gate.begin()!
    expect(gate.isCurrent(old)).toBe(false);expect(gate.finish(old)).toBe(false)
    expect(gate.isCurrent(current)).toBe(true)
  })
  it('invalidates in-flight work on unmount',()=>{
    const gate=createUploadGate(),token=gate.begin()!
    gate.cancel();expect(gate.isCurrent(token)).toBe(false);expect(gate.finish(token)).toBe(false)
  })
})
