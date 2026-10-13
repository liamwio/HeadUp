import {spawnSync} from 'node:child_process'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
function run(command,args){const r=spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error||r.status!==0)throw Error('iOS构建未完成，未生成可交付的安装包。')}
try{
  if(process.platform!=='darwin')throw Error('iOS原生编译需要Mac和Xcode 26+。Windows可运行pnpm ios:prepare准备工程，不能生成签名IPA。')
  run('xcodebuild',['-version'])
  if(!process.argv.includes('--prepared'))run(process.execPath,[join(root,'scripts/prepare-ios.mjs')])
  const common=['-project','ios/App/App.xcodeproj','-scheme','App']
  if(process.argv.includes('--archive')){
    const team=process.env.APPLE_TEAM_ID
    if(!team||!/^[A-Z0-9]{10}$/.test(team))throw Error('归档需要APPLE_TEAM_ID以及本机Xcode中已配置的签名证书和描述文件。也可直接打开工程选择签名团队。')
    run('xcodebuild',[...common,'-configuration','Release','-destination','generic/platform=iOS','-archivePath','releases/ios/HeadUp.xcarchive','DEVELOPMENT_TEAM='+team,'archive'])
    console.log('已完成xcarchive归档。请在Xcode Organizer中按自己的签名方式导出IPA或分发。')
  }else{
    run('xcodebuild',[...common,'-configuration','Debug','-sdk','iphonesimulator','-destination','generic/platform=iOS Simulator','-derivedDataPath','ios/DerivedData','CODE_SIGNING_ALLOWED=NO','build'])
    console.log('模拟器App已编译：ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app（不是iPhone安装包）。')
  }
}catch(error){console.error(error.message);process.exitCode=1}
