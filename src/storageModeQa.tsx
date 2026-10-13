import {createRoot} from 'react-dom/client'
import {FamilySettings} from './family/FamilySettings'
import {createProfile} from './family/model'
import {configurePhotoDirectory} from './family/photoDirectory'
import './appStyles'
import './family/family.css'
const noop=()=>{},profile=createProfile({nickname:'示例档案',guardianConfirmed:true,childInformed:true,storage:true})
configurePhotoDirectory({photoDirectory:async()=>({directory:'Pictures/HeadUp/示例档案_profile/',shared:true}),beginPhotoCopy:async()=>{throw Error('QA only')},appendPhotoCopy:async()=>{},finishPhotoCopy:async()=>({directory:''}),abortPhotoCopy:async()=>{}})
createRoot(document.getElementById('root')!).render(<div className="family-app" style={{padding:20,maxWidth:500,margin:'auto'}}><FamilySettings profile={profile} onShare={noop} onCreate={noop} onEdit={noop} onProfile={noop} onRefresh={async()=>{}} onDeleted={noop} onAccount={noop}/></div>)
