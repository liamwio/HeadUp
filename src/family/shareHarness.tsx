import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import '../appStyles'
configureLocalFamilyStore(new FamilyStore('headup-share-ui-qa-19',true));configureWorkspacePreferences('share-ui-qa-19')
const root=createRoot(document.getElementById('root')!);root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离分享验收：临时账号与公开工程素材，不含真实家庭资料。</div><FamilyApp apiBase="/qa-family-api" allowLocalShare/></>);import.meta.hot?.dispose(()=>root.unmount())
