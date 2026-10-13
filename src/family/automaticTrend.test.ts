import {it,expect} from 'vitest'
import {buildAutomaticTrend,automaticTrendReady,trendSaveDestination} from './automaticTrend'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultProtocol,type FamilySession} from './model'
import type {ConsumerReading} from '../lib/consumerReport'
const profileId='trend-profile'
function reading(value:number,side=false):ConsumerReading{return {code:side?'PROFILE-RATIO-05':'FRONT-RATIO-07',value:value.toFixed(2)+'%',label:'测试比例',score:0,note:'',group:side?'侧貌':'比例',view:side?'profile':'front',available:true,origin:'experimental',formula:'same-formula',errors:[],evidence:{version:'HEADUP-POINT-LINE-1',source:side?'saved_profile_landmarks':'saved_front_landmarks',width:100,height:100,points:[{id:'a',label:'A',x:10,y:20},{id:'b',label:'B',x:30,y:40}],segments:[{id:'s',label:'line',from:'a',to:'b',role:'measure'}],formula:'same-evidence'}}}
function session(i:number,view:'front'|'left_profile'|'right_profile'='front'):FamilySession{
 const s=structuredClone(archiveFixture().sessions[0]);s.id='record-'+i;s.profileId=profileId;s.recordedOn=`2026-09-${String(i+1).padStart(2,'0')}`;s.createdAt=s.updatedAt=s.recordedOn+'T12:00:00Z';s.kind='measurement';s.recordedBy='user';s.dateSource='user_confirmed';s.revision=undefined
 s.protocol={...defaultProtocol(),device:'same',camera:'rear',distanceCm:100,light:'daylight'}
 const id=view==='front'?'front':view==='left_profile'?'profile':'right_profile'
 s.captures=[{id,label:view,hint:'',eyebrow:'',mediaId:s.id+'/'+id,quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:view,detectedFaces:1,flags:[]}}]
 s.contentKey=id+':'+(i+1).toString(16).padStart(64,'0');s.report.front=view==='front'?[reading(40+i)]:[];s.report.profile=view==='front'?[]:[reading(5+i,true)];s.report.extended=[];s.report.isExample=false
 if(view==='right_profile'){s.rightProfileReport=structuredClone(s.report);s.report.profile=[reading(999,true)]}
 return s
}
it('generates on the third photo record and updates after additions or deletion',()=>{
 const rows=[session(0),session(1),session(2)]
 expect(automaticTrendReady(rows.slice(0,2),profileId)).toBe(false);expect(trendSaveDestination(rows.slice(0,2),rows[2])).toBe('summary')
 expect(buildAutomaticTrend(rows,profileId).views[0].series[0]).toMatchObject({comparable:true,differences:[2]})
 expect(buildAutomaticTrend([...rows,session(3)],profileId).views[0].series[0].points).toHaveLength(4)
 expect(buildAutomaticTrend(rows.slice(0,2),profileId).ready).toBe(false)
})
it('counts revisions once and does not turn same-day repeats into three time points',()=>{
 const a=session(0),revision={...structuredClone(a),id:'revision',revision:{rootId:a.id,parentId:a.id,number:1,operation:'reanalyze' as const,views:['front' as const]}}
 expect(buildAutomaticTrend([a,revision,session(1)],profileId).recordCount).toBe(2)
 const rows=[0,1,2].map(i=>({...session(i),recordedOn:'2026-09-01'})),r=buildAutomaticTrend(rows,profileId)
 expect(r.ready).toBe(true);expect(r.views[0].series[0].points).toHaveLength(1);expect(r.views[0].series[0].differences).toBeNull()
})
it('does not connect missing-condition records or mix formula versions, reused photos and demo data',()=>{
 const rows=[session(0),session(1),session(2)];rows[1].protocol.distanceCm=null
 expect(buildAutomaticTrend(rows,profileId).views[0].series[0].differences).toBeNull()
 rows[1].protocol.distanceCm=100;rows[0].version.algorithm='old'
 expect(buildAutomaticTrend(rows,profileId).views[0].series[0].points).toHaveLength(2)
 rows[0].version=structuredClone(rows[2].version);rows[0].contentKey=rows[2].contentKey
 expect(buildAutomaticTrend(rows,profileId).views[0].series[0].points).toHaveLength(2)
 rows[0].report.isExample=true;expect(buildAutomaticTrend(rows,profileId).views[0].series[0].comparable).toBe(false)
})
it('automatically excludes a different-camera middle record when three current-camera dates exist',()=>{
 const rows=[0,1,2,3].map(i=>session(i));rows[1].protocol.device='other'
 const s=buildAutomaticTrend(rows,profileId).views[0].series[0]
 expect(s.comparable).toBe(true);expect(s.points.map(p=>p.sessionId)).toEqual(['record-0','record-2','record-3'])
})
it('keeps left/right independent and uses right frozen readings instead of the left report',()=>{
 const rows=[0,1,2].map(i=>session(i,'right_profile')),r=buildAutomaticTrend(rows,profileId)
 expect(r.views[1].series).toEqual([]);expect(r.views[2].series[0].points.map(p=>p.values[0])).toEqual([5,6,7]);expect(r.views[2].series[0].differences).toEqual([2])
})
it('automatically reports memory photos but never invents numeric trends, and never mutates records',()=>{
 const rows=[0,1,2].map(i=>({...session(i),kind:'memory' as const})),before=structuredClone(rows),r=buildAutomaticTrend(rows,profileId)
 expect(r.ready).toBe(true);expect(r.comparable).toBe(0);expect(rows).toEqual(before)
 expect(buildAutomaticTrend(rows,'other').recordCount).toBe(0)
})
