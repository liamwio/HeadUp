import {createRoot} from 'react-dom/client'
import {PhonePhotoDirectory} from './PhonePhotoDirectory'
import {configurePhotoDirectory,type PhotoDirectoryApi} from './photoDirectory'
import {configureLocalFamilyStore,FamilyStore} from './store'
import {archiveFixture} from './backupVolumes.fixture'
import '../appStyles'
import './family.css'
const store=new FamilyStore('headup-photo-copy-ui-qa-20261012',true);configureLocalFamilyStore(store)
let archive=archiveFixture();const existing=await store.snapshot();if(!existing.profiles.length)await store.restore(archive);else archive={...archive,...existing,media:[]}
const profile=(await store.snapshot()).profiles[0];let fail=true
const location={directory:'Pictures/HeadUp/工程档案_'+profile.id+'/',shared:true}
configurePhotoDirectory({photoDirectory:async()=>location,beginPhotoCopy:async()=>({alreadySaved:false,token:'qa',directory:location.directory}),appendPhotoCopy:async()=>{if(fail)throw Error('模拟磁盘空间不足')},finishPhotoCopy:async()=>({directory:location.directory}),abortPhotoCopy:async()=>{}} satisfies PhotoDirectoryApi)
createRoot(document.getElementById('root')!).render(<div className="family-app" style={{padding:20,maxWidth:600,margin:'auto'}}><h1>手机目录隔离验收</h1><p>仅合成图形与模拟适配器；不会向手机写入文件。</p><button onClick={()=>{fail=false}}>恢复模拟写入</button><PhonePhotoDirectory profile={profile}/></div>)
