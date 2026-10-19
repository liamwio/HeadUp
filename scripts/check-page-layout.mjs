import {readdirSync,readFileSync,existsSync} from 'node:fs'
import {resolve,dirname,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const list=dir=>readdirSync(resolve(root,dir)).filter(name=>name.endsWith('.html')).map(name=>dir?`${dir}/${name}`:name)
const failures=[],rootPages=list('')
if(rootPages.length!==1||rootPages[0]!=='index.html')failures.push('Root must contain only index.html')
const pages=['index.html',...list('tests/pages'),...list('research/pages')]
for(const page of pages){
 const html=readFileSync(resolve(root,page),'utf8')
 for(const [,ref] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)){
  if(/^(?:https?:|data:|mailto:|#)/.test(ref)||ref.includes('${'))continue
  const path=ref.split(/[?#]/)[0]
  if(!/\.(?:html|[cm]?js|tsx?|css)$/.test(path)||/^\/(?:data|\.local-archive|@fs)\//.test(path))continue
  const target=path.startsWith('/')?resolve(root,'.'+path):resolve(root,dirname(page),path)
  if(!existsSync(target))failures.push(`${page}: missing ${ref} (${relative(root,target)})`)
 }
}
if(existsSync(resolve(root,'dist/index.html'))){
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(dir,e.name)):e.name.endsWith('.html')?[relative(resolve(root,'dist'),resolve(dir,e.name)).replaceAll('\\','/')]:[])
 const html=walk(resolve(root,'dist'))
 if(html.length!==1||html[0]!=='index.html')failures.push('Production dist contains test/research HTML')
}
if(existsSync(resolve(root,'dist-research/index.html')))for(const page of pages)if(!existsSync(resolve(root,'dist-research',page)))failures.push(`Research output missing ${page}`)
if(failures.length){console.error(failures.join('\n'));process.exitCode=1}else console.log(`PASS: ${pages.length} app/test/research pages; local links and build separation checked.`)
