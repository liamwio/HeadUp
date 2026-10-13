import {createRoot} from 'react-dom/client'
import {configureWorkspacePreferences} from './cloudRuntime'
import {CloudAccountPanel} from './CloudAccountPanel'
import '../appStyles'
import './family.css'
configureWorkspacePreferences('isolated-family-qa')
createRoot(document.getElementById('root')!).render(<div className="family-app"><main style={{maxWidth:1000,margin:'0 auto',padding:24}}><p className="family-notice">工程隔离验收：仅连接临时内存数据库与独立测试Cookie，不使用真实账号或照片。</p><CloudAccountPanel apiBase="/qa-family-api" onBack={()=>{location.href='/family-account-qa.html'}}/></main></div>)
