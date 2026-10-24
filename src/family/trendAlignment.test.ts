import {it,expect} from 'vitest'
import {alignReference,transformPoint,trendAlignment,trendPhotoRecords} from './trendAlignment'
import {archiveFixture} from './backupVolumes.fixture'
import {defaultProtocol} from './model'
function pair(){
 const [a,b]=[0,1].map(i=>{const s=structuredClone(archiveFixture().sessions[0]);s.id='visit-'+i;s.profileId='profile';s.recordedOn=`2026-0${i+1}-01`;s.createdAt=s.updatedAt=s.recordedOn+'T00:00:00Z';s.dateSource='live_capture';s.revision=undefined;s.kind='measurement';s.contentKey='front:'+String(i).repeat(64);s.protocol={...defaultProtocol(),device:'camera',camera:'rear',distanceCm:100,light:'daylight'};s.captures=[{id:'front',label:'正面',hint:'',eyebrow:'',mediaId:s.id+'/front',quality:{score:90,resolution:100,brightness:128,contrast:40,sharpness:100,flags:[]},poseValidation:{status:'pass',estimatedPose:'front',detectedFaces:1,flags:[]}}];s.report.isExample=false;s.report.extended=[];s.report.front=[{view:'front',code:'FRONT-RATIO-07',label:'比例',value:'40%',available:true,score:0,note:'',origin:'experimental',group:'比例',formula:'same',evidence:{version:'HEADUP-POINT-LINE-1',source:'saved_front_landmarks',width:400,height:500,formula:'same',points:[{id:'a',label:'top',x:200+i*5,y:80},{id:'b',label:'bottom',x:200+i*5,y:400},{id:'c',label:'nose',x:200+i*5,y:270}],segments:[{id:'denominator',label:'脸高',from:'a',to:'b',role:'reference'},{id:'numerator',label:'下脸',from:'c',to:'b',role:'measure'}]}}];return s});return {a,b}
}
it('maps exact saved endpoints using uniform scale and rotation without warping',()=>{
 const p=(x:number,y:number)=>({id:'p',label:'p',x,y})
 const m=alignReference(p(10,20),p(10,60),p(30,50),p(70,50))!
 expect(transformPoint(m,p(10,20))).toEqual({x:30,y:50});expect(transformPoint(m,p(10,60))).toEqual({x:70,y:50})
 expect(Math.hypot(m[0],m[1])).toBeCloseTo(Math.hypot(m[2],m[3]));expect(m[0]*m[2]+m[1]*m[3]).toBeCloseTo(0)
 expect(alignReference(p(1,1),p(1,1),p(2,2),p(3,3))).toBeNull()
})
it('uses stored geometry and leaves every saved point and reading unchanged',()=>{
 const {a,b}=pair(),before=JSON.stringify([a,b]),result=trendAlignment(a,b,'front');expect(result.ok).toBe(true)
 if(result.ok){expect(result.matrix).toEqual([1,0,-0,1,5,0]);expect(result.before).toBe(a.report.front[0].evidence)}
 expect(JSON.stringify([a,b])).toBe(before)
})
it('blocks incompatible algorithms, unknown conditions, reused photos and biased captures',()=>{
 for(const change of [(b:any)=>b.version.algorithm='old',(b:any)=>b.protocol.distanceCm=null,(b:any)=>b.contentKey='front:'+'0'.repeat(64),(b:any)=>b.captures[0].acceptedWithBias=true,(b:any)=>b.report.front[0].evidence.source='saved_profile_landmarks']){
  const {a,b}=pair();change(b);expect(trendAlignment(a,b,'front').ok).toBe(false)
 }
})
it('does not align mismatched semantic anchors, degenerate or nonfinite points',()=>{
 for(const change of [(e:any)=>e.segments[0].label='different',(e:any)=>e.points[0].x=NaN,(e:any)=>e.points[1]={...e.points[1],x:e.points[0].x,y:e.points[0].y},(e:any)=>e.width=0]){
  const {a,b}=pair();change(b.report.front[0].evidence);expect(trendAlignment(a,b,'front').ok).toBe(false)
 }
})
it('retains earliest baseline, latest visits and only latest revision per date',()=>{
 const {a}=pair(),rows=Array.from({length:20},(_,i)=>({...a,id:'row'+i,recordedOn:`2026-01-${String(i+1).padStart(2,'0')}`,updatedAt:'2026-02-01'}))
 const selected=trendPhotoRecords([...rows,{...rows[19],id:'revision',updatedAt:'2026-02-02'}]);expect(selected).toHaveLength(12);expect(selected[0].id).toBe('row0');expect(selected.at(-1)?.id).toBe('revision')
})

it('supports saved profile geometry but never overlays opposite sides',()=>{
 const {a,b}=pair()
 for(const s of [a,b]){s.captures[0].id='profile';s.captures[0].poseValidation!.estimatedPose='left_profile';s.contentKey=s.contentKey!.replace('front:','profile:');s.report.profile=s.report.front.map(r=>({...r,view:'profile',code:'PROFILE-RATIO-07',evidence:{...r.evidence!,source:'saved_profile_landmarks'}}));s.report.front=[]}
 expect(trendAlignment(a,b,'profile').ok).toBe(true)
 b.captures[0].poseValidation!.estimatedPose='right_profile';expect(trendAlignment(a,b,'profile').ok).toBe(false)
})
