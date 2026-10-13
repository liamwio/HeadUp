import {createRoot} from 'react-dom/client'
import FamilyApp from './FamilyApp'
import {FamilyStore,configureLocalFamilyStore} from './store'
import {configureWorkspacePreferences} from './cloudRuntime'
import {archiveFixture} from './backupVolumes.fixture'
import '../appStyles'
import './family.css'
const store=new FamilyStore('headup-sync-ui-qa-local',true)
configureLocalFamilyStore(store);configureWorkspacePreferences('isolated-family-qa')
if(!(await store.snapshot()).profiles.length){const archive=archiveFixture();archive.profiles[0].nickname='同步工程档案';archive.profiles[0].purpose='隔离验收，只使用工程资料';await store.restore(archive)}
createRoot(document.getElementById('root')!).render(<><div style={{padding:8,background:'#fff1c9',position:'relative',zIndex:100}}>隔离同步验收：使用独立本机数据库、测试账号和临时服务器。</div><FamilyApp apiBase="/qa-family-api"/></>)
