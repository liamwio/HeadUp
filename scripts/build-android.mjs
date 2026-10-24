import {spawnSync} from 'node:child_process'
import {existsSync,realpathSync,readdirSync,mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tools=existsSync(join(root,'.android-tools'))?realpathSync(join(root,'.android-tools')):join(root,'.android-tools')
function run(command,args,cwd=root,env=process.env){const result=spawnSync(command,args,{cwd,env,stdio:'inherit',windowsHide:true});if(result.error||result.status!==0)throw new Error('构建未完成，请先处理上方错误；未发布新的APK。')}
try{
  const localJava=join(tools,'java'),java=process.env.JAVA_HOME||(existsSync(localJava)?join(localJava,readdirSync(localJava).find(name=>name.startsWith('jdk-21'))??'missing'):''),sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||join(tools,'sdk')
  if(!java||!existsSync(join(java,'bin',process.platform==='win32'?'java.exe':'java')))throw new Error('需要JDK 21。请安装Android Studio或设置JAVA_HOME。')
  if(!existsSync(join(sdk,'platforms','android-36','android.jar'))||!existsSync(join(sdk,'build-tools','36.0.0')))throw new Error('需要Android SDK Platform 36和Build Tools 36.0.0。请通过SDK Manager安装并接受许可。')
  const env={...process.env,JAVA_HOME:java,ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk,GRADLE_USER_HOME:process.env.GRADLE_USER_HOME||join(tools,'gradle-cache')}
  const proxyArgs=[]
  const proxyValue=process.env.HTTPS_PROXY||process.env.ALL_PROXY||process.env.HTTP_PROXY
  if(proxyValue){const proxy=new URL(proxyValue),host=proxy.hostname,port=Number(proxy.port||(['http:','https:'].includes(proxy.protocol)?proxy.protocol==='https:'?443:80:1080));if(!proxy.username&&/^[a-zA-Z0-9.\-\[\]:]+$/.test(host)&&Number.isInteger(port)&&port>0&&port<=65535){if(proxy.protocol.startsWith('socks'))proxyArgs.push('-DsocksProxyHost='+host,'-DsocksProxyPort='+port);else if(['http:','https:'].includes(proxy.protocol))for(const protocol of ['http','https'])proxyArgs.push('-D'+protocol+'.proxyHost='+host,'-D'+protocol+'.proxyPort='+port)}}
  run(process.execPath,['node_modules/typescript/bin/tsc','-b','--pretty','false'])
  run(process.execPath,['node_modules/vite/bin/vite.js','build','--config','vite.android.config.ts'])
  run(process.execPath,['node_modules/@capacitor/cli/bin/capacitor','sync','android'])
  if(process.platform==='win32')run('cmd.exe',['/d','/c','gradlew.bat','--no-daemon',...proxyArgs,':app:assembleDebug',':app:testDebugUnitTest',':app:lintDebug'],join(root,'android'),env)
  else run('./gradlew',['--no-daemon',...proxyArgs,':app:assembleDebug',':app:testDebugUnitTest',':app:lintDebug'],join(root,'android'),env)
  const source=join(root,'android/app/build/outputs/apk/debug/app-debug.apk'),folder=join(root,'releases/android'),target=join(folder,'HeadUp-1.1.13-apponly-debug.apk')
  mkdirSync(folder,{recursive:true});copyFileSync(source,target)
  const apk=readFileSync(target),sha256=createHash('sha256').update(apk).digest('hex')
  writeFileSync(join(folder,'HeadUp-1.1.13-apponly-debug.sha256'),sha256+'  HeadUp-1.1.13-apponly-debug.apk\n')
  writeFileSync(join(folder,'build-info.json'),JSON.stringify({appId:'com.headup.growth',version:'1.1.13-apponly',build:'debug',builtAt:new Date().toISOString(),bytes:apk.length,sha256,minSdk:24,targetSdk:36},null,2))
  console.log('\nAndroid测试安装包已生成：'+target+'\nSHA-256：'+sha256)
}catch(error){console.error(error.message);process.exitCode=1}
