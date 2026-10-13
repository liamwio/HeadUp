import {expect,it} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {archiveFixture} from './backupVolumes.fixture'
import {encryptArchive,decryptArchive} from './backup'
import {prepareBackupVolumes,decryptBackupFiles} from './backupVolumes'
import {createHeightRecord,heightRecords} from './heightRecords'
import {eventDetails} from './eventDetails'
import {sessionPurpose} from './model'
import {ProfileForm} from './ProfileForm'
import {MeasurementOverlay} from '../MeasurementOverlay'
import {consultationMetrics,selectConsultationRecords} from './consultationPdf'
it('keeps raw legacy purposes in single and multivolume backups while mapping only display text',async()=>{
 const a=archiveFixture();a.sessions.forEach(s=>{s.purpose='骨骼发育'})
 const e=createHeightRecord(a.profiles[0].id,'2026-09-17',150.24,'手动尺测');a.events=[e]
 const single=await decryptArchive(await encryptArchive(a,'test-phase-one'),'test-phase-one')
 const volumes=await prepareBackupVolumes(a,'test-phase-one'),parts=await Promise.all(Array.from({length:volumes.count},(_,i)=>volumes.volume(i)))
 const multi=await decryptBackupFiles(parts,'test-phase-one')
 for(const restored of [single,multi]){expect(restored.sessions[0].purpose).toBe('骨骼发育');expect(sessionPurpose(restored.sessions[0])).toBe('面部生长记录');expect(restored.events[0].height).toEqual({centimeters:150.2,source:'手动尺测'});expect(restored.events[0].detailsVersion).toBe('HEADUP-EVENT-2')}
 expect(sessionPurpose({...a.sessions[0],purpose:'自定义用途'})).toBe('自定义用途')
})
it('rejects invalid height/date/source and excludes other profiles from height curves',()=>{
 for(const v of [NaN,Infinity,0,999])expect(()=>createHeightRecord('p','2026-09-01',v,'尺测')).toThrow()
 expect(()=>createHeightRecord('p','2999-09-01',150,'尺测')).toThrow()
 expect(()=>createHeightRecord('p','2026-09-01',150,'')).toThrow()
 const e=createHeightRecord('p','2026-09-01',150,'尺测');expect(()=>eventDetails({...e,detailsVersion:'HEADUP-EVENT-1'})).toThrow()
 expect(heightRecords([e,{...e,id:'other',profileId:'other'}],'p')).toHaveLength(1)
})
it('offers recent birth years while preserving the year of an older saved profile',()=>{
 const existing={...archiveFixture().profiles[0],birthYear:1980}
 expect(renderToStaticMarkup(<ProfileForm onSave={async()=>{}}/>)).not.toContain('1900年')
 expect(renderToStaticMarkup(<ProfileForm existing={existing} onSave={async()=>{}}/>)).toContain('1980年')
})
it('shows point labels only when requested, keeping the same saved geometry',()=>{
 const evidence={version:'HEADUP-POINT-LINE-1' as const,source:'saved_front_landmarks' as const,width:100,height:100,points:[{id:'a',label:'额部可见点',x:10,y:20},{id:'b',label:'下巴',x:20,y:40}],segments:[{id:'s',label:'参考',from:'a',to:'b',role:'measure' as const}],formula:'test'}
 const small=renderToStaticMarkup(<MeasurementOverlay evidence={evidence}/>),big=renderToStaticMarkup(<MeasurementOverlay evidence={evidence} showLabels/>)
 expect(small).not.toContain('<text');expect(big).toContain('<text');expect(small).toContain('x1="10"');expect(big).toContain('x1="10"')
})
it('exports only selected latest records of the current profile and never borrows opposite-side values',()=>{
 const a=archiveFixture(),latest=a.sessions[1]
 expect(selectConsultationRecords(a.sessions,a.profiles[0].id,[latest.id])).toEqual([latest])
 expect(()=>selectConsultationRecords(a.sessions,'other',[latest.id])).toThrow()
 expect(()=>selectConsultationRecords(a.sessions,a.profiles[0].id,[latest.id,latest.id])).toThrow()
 const s={...latest,kind:'measurement' as const,report:{...latest.report,profile:[{code:'PROFILE-ANGLE-01',label:'left',value:'111°',score:0,note:'',group:'侧貌' as const,view:'profile' as const,available:true,origin:'experimental' as const}]}}
 expect(consultationMetrics(s).slice(2)).toEqual(['未测出','未测出'])
})
