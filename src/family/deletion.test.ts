import 'fake-indexeddb/auto'
import {afterEach,it,expect} from 'vitest'
import {FamilyStore} from './store'
import {archiveFixture} from './backupVolumes.fixture'
import {archiveStamp} from './syncState'
import {recoveryStamp} from './deletionReview'
import {cloudWritePolicy} from './cloudWritePolicy'
const stores:FamilyStore[]=[]
const store=()=>{const s=new FamilyStore('unit-deletion-'+crypto.randomUUID());stores.push(s);return s}
afterEach(async()=>{for(const s of stores.splice(0)){await s.close();await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase(s.name);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}})
async function setup(){
  const s=store(),a=archiveFixture(),b=archiveFixture();await s.restore(a);await s.restore(b)
  for(const archive of [a,b]){const id=archive.profiles[0].id,link=await s.saveSyncLink({profileId:id,familyId:'family',userId:'owner',enabled:true,role:'owner',generation:-1,version:1,baseHash:'base',baseStamp:archiveStamp(archive),status:'synced',updatedAt:new Date().toISOString()},-1);await s.applyCloud(id,archive,archiveStamp(archive),link!,'工程副本')}
  return{s,a,b}
}
it('clears only the reviewed workspace while retaining deletion synchronization receipts',async()=>{
  const {s}=await setup(),other=store(),outside=archiveFixture();await other.restore(outside)
  const review=await s.deletionReview();expect(review).toMatchObject({records:2,versions:4,photos:4,recoveries:2,recoveryPhotos:4,connected:2,paused:0})
  await s.clear(review.stamp)
  expect(await s.archive()).toEqual({profiles:[],sessions:[],media:[],events:[],plans:[]});expect(await s.syncRecoveries()).toEqual([]);expect(await s.syncLinks()).toHaveLength(2)
  expect((await other.archive()).profiles).toHaveLength(1);expect((await other.archive()).media).toHaveLength(2)
})
it.each(['profile','note','sync','recovery'] as const)('rejects a stale whole-workspace deletion after a concurrent %s change without partial deletion',async change=>{
  const {s,a}=await setup(),review=await s.deletionReview(),id=a.profiles[0].id
  if(change==='profile')await s.restore(archiveFixture())
  if(change==='note')await s.putEvent({id:'new-event',profileId:id,date:'2026-09-20',type:'memory',text:'预览后新增',createdAt:new Date().toISOString()})
  if(change==='sync'){const link=(await s.syncState(id)).link!;await s.saveSyncLink({...link,enabled:false,status:'paused'},link.generation)}
  if(change==='recovery'){const state=await s.syncState(id);await s.applyCloud(id,state.archive,state.stamp,state.link!,'新副本')}
  const before=await s.deletionReview();await expect(s.clear(review.stamp)).rejects.toThrow('本次未删除');expect((await s.deletionReview()).stamp).toBe(before.stamp)
})
it('checks the current workspace again inside the deletion transaction',async()=>{
  const {s}=await setup(),review=await s.deletionReview()
  await expect(s.clear(review.stamp,()=>false)).rejects.toThrow('本次未删除');expect((await s.deletionReview()).stamp).toBe(review.stamp)
})
it('removes one reviewed conflict copy without modifying current archives, sync links or other copies',async()=>{
  const {s}=await setup(),before=archiveStamp(await s.archive()),links=await s.syncLinks(),copies=await s.syncRecoveries(),target=copies[0]
  await expect(s.deleteRecovery(target.id,'stale')).rejects.toThrow('副本已变化');expect(await s.syncRecoveries()).toHaveLength(2)
  await s.deleteRecovery(target.id,recoveryStamp(target));expect((await s.syncRecoveries()).map(r=>r.id)).toEqual([copies[1].id]);expect(archiveStamp(await s.archive())).toBe(before);expect(await s.syncLinks()).toEqual(links)
  await expect(s.deleteRecovery(target.id,recoveryStamp(target))).rejects.toThrow('另一页面删除')
})
it('lets a child clear their local recovery but rejects whole-workspace deletion',async()=>{
  const {s}=await setup();s.mutationGuard=cloudWritePolicy(s,'child',()=> 'child')
  const review=await s.deletionReview(),copy=(await s.syncRecoveries())[0]
  await expect(s.clear(review.stamp)).rejects.toThrow('角色');expect((await s.deletionReview()).stamp).toBe(review.stamp)
  await s.deleteRecovery(copy.id,recoveryStamp(copy));expect(await s.syncRecoveries()).toHaveLength(1);expect((await s.archive()).profiles).toHaveLength(2)
})
