import {PROFILE_DISPLAY_PATHS} from './profileDisplayContract'
import type {NativeProfilePath} from './nativeProfilePresentation'

type Source={width:number;height:number;points?:readonly {index:number;x:number;y:number}[];paths:readonly NativeProfilePath[]}
/** Correct display topology for both new output and immutable saved reports. */
export function resolveProfileDisplayPaths(source:Source):NativeProfilePath[]{
  const {width,height}=source
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return []
  const points=source.points,byIndex=new Map(points?.map(p=>[p.index,p]))
  const complete=points?.length===39&&byIndex.size===39&&Array.from({length:39},(_,i)=>byIndex.get(i)).every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=width&&p.y>=0&&p.y<=height)
  const validPath=(p:NativeProfilePath)=>p.points.length>=2&&p.points.every(q=>Number.isFinite(q.x)&&Number.isFinite(q.y)&&q.x>=0&&q.x<=width&&q.y>=0&&q.y<=height)
  const verified=complete?PROFILE_DISPLAY_PATHS.map(path=>({code:path.code,label:path.label,category:'region' as const,points:path.indices.map(index=>{const p=byIndex.get(index)!;return{x:p.x,y:p.y}})})):[]
  // A partial saved report cannot safely recover old forehead/lip paths. Preserve
  // only the unchanged, known jaw topology; never guess missing point identities.
  const fallback=points?.length?[]:source.paths.filter(p=>p.code==='mandibular_aesthetic_line'&&validPath(p))
  const optional=source.paths.filter(p=>(p.category==='evidence'||p.code==='neck_aesthetic_line'&&!p.provisional)&&validPath(p))
  return [...verified,...fallback,...optional]
}
