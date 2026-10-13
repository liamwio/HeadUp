import {it,expect} from 'vitest'
import {resolveProfileDisplayPaths} from './profileDisplayPolicy'
import type {NativeProfilePath} from './nativeProfilePresentation'
const points=Array.from({length:39},(_,index)=>({index,x:100+index*5,y:100+index*6}))
const old=(code:string,indices:number[],provisional=false):NativeProfilePath=>({code,label:code,category:'region',provisional,points:indices.map(i=>({x:points[i].x,y:points[i].y}))})
it('repairs frozen legacy nose/eye/lip connectors without editing a saved record',()=>{
 const source={width:800,height:1000,points,paths:[old('forehead_aesthetic_line',[12,13,14,15,16,17]),old('maxillary_support_line',[21,22,23,24,25,26,27]),old('neck_aesthetic_line',[8,9],true)]},before=structuredClone(source)
 const paths=resolveProfileDisplayPaths(source)
 expect(source).toEqual(before)
 expect(paths.find(p=>p.code==='upper_lip_contour')!.points).toEqual(points.slice(27,31).map(({x,y})=>({x,y})))
 expect(paths.find(p=>p.code==='nasal_dorsum_line')!.points).toEqual(points.slice(16,20).map(({x,y})=>({x,y})))
 expect(paths.some(p=>['maxillary_support_line','forehead_aesthetic_line','neck_aesthetic_line'].includes(p.code))).toBe(false)
})
it('does not guess missing historical landmark identities or draw corrupt paths',()=>{
 const source={width:800,height:1000,paths:[old('forehead_aesthetic_line',[12,13]),old('maxillary_support_line',[21,27]),old('mandibular_aesthetic_line',[4,5,6,7,8,9,10])]}
 expect(resolveProfileDisplayPaths(source).map(p=>p.code)).toEqual(['mandibular_aesthetic_line'])
 expect(resolveProfileDisplayPaths({...source,width:NaN})).toEqual([])
 expect(resolveProfileDisplayPaths({...source,points:points.map((p,i)=>i===22?{...p,x:Infinity}:p)})).toEqual([])
})
