import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
function run(args,cwd=root){const r=spawnSync(process.execPath,args,{cwd,stdio:'inherit',windowsHide:true});if(r.error||r.status!==0)throw Error('iOS资源准备失败，请检查上方错误。')}
try{
  if(!existsSync(join(root,'ios/App/App.xcodeproj/project.pbxproj')))throw Error('缺少iOS原生工程，请恢复项目中的ios目录。')
  run(['node_modules/typescript/bin/tsc','-b','--pretty','false'])
  run(['node_modules/vite/bin/vite.js','build','--config','vite.ios.config.ts'])
  run([join(root,'node_modules/@capacitor/cli/bin/capacitor'),'sync','ios'],join(root,'ios-config'))
  console.log('iOS资源已准备：ios/App/App.xcodeproj。尚未编译或签名IPA。')
  if(process.argv.includes('--open')){
    if(process.platform!=='darwin')throw Error('打开Xcode需要Mac；当前仅完成工程资源准备。')
    run([join(root,'node_modules/@capacitor/cli/bin/capacitor'),'open','ios'],join(root,'ios-config'))
  }
}catch(error){console.error(error.message);process.exitCode=1}
