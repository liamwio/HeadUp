import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import '../appStyles'
import './family.css'
configureLocalFamilyStore(new FamilyStore('headup-audit-ui-qa-09',true))
configureWorkspacePreferences('audit-ui-qa-09')
const root=createRoot(document.getElementById('root')!)
root.render(<><div style={{padding:8,background:'#fff1c9'}}>隔离验收：独立测试档案；请勿录入真实家庭资料。</div><FamilyApp apiBase="/qa-family-api"/></>)
import.meta.hot?.dispose(()=>root.unmount())
