import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import '../appStyles'
configureLocalFamilyStore(new FamilyStore('headup-handoff-ui-qa-12',true));configureWorkspacePreferences('handoff-ui-qa-12')
const root=createRoot(document.getElementById('root')!);root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离接力验收：仅本机测试链接，使用工程账号和临时服务器。</div><FamilyApp apiBase="/qa-family-api" allowLocalHandoff/></>);import.meta.hot?.dispose(()=>root.unmount())
