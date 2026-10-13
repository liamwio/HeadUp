/// <reference types="node" />
import {readFileSync} from 'node:fs'
import {it,expect} from 'vitest'
import bundledNeckRuntime from '../data/profile-neck-aesthetic-runtime-v1.json'
it('keeps the bundled neck runtime identical to the public research manifest',()=>{
  const published=JSON.parse(readFileSync(new URL('../../public/models/profile-neck-aesthetic-runtime-v1.json',import.meta.url),'utf8'))
  expect(bundledNeckRuntime).toEqual(published)
})
