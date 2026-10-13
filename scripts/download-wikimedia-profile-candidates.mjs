import{createHash}from'node:crypto'
import{mkdir,readFile,writeFile}from'node:fs/promises'
import{basename,join}from'node:path'
import{fileURLToPath}from'node:url'

const root=fileURLToPath(new URL('../',import.meta.url)),outputDir=join(root,'data','face-db-real-research','wikimedia-profile-candidates'),imageDir=join(outputDir,'images'),api='https://commons.wikimedia.org/w/api.php',category='Category:Profile views of people (right)',userAgent='HeadUpResearch/1.0 (local research validation)'
await mkdir(imageDir,{recursive:true})
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
async function fetchWithRetry(url,attempts=4){let lastError;for(let attempt=0;attempt<attempts;attempt++){try{const response=await fetch(url,{headers:{'User-Agent':userAgent}});if(response.ok)return response;if(response.status!==429&&response.status<500)throw new Error(`HTTP ${response.status}`);lastError=new Error(`HTTP ${response.status}`)}catch(error){lastError=error}await wait(Math.min(12000,1800*2**attempt))}throw lastError??new Error('HTTP retry budget exhausted')}
const clean=value=>String(value??'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()
const allowedLicense=/^(CC0|CC BY(?:-SA)?(?: \d\.\d)?|Public domain|PDM)/i
let continuation='',pages=[]
do{
  const params=new URLSearchParams({action:'query',generator:'categorymembers',gcmtitle:category,gcmtype:'file',gcmlimit:'50',prop:'imageinfo',iiprop:'url|size|mime|extmetadata',iiurlwidth:'1400',format:'json',formatversion:'2',origin:'*'})
  if(continuation)params.set('gcmcontinue',continuation)
  const response=await fetchWithRetry(`${api}?${params}`)
  const payload=await response.json();pages.push(...(payload.query?.pages??[]));continuation=payload.continue?.gcmcontinue??''
}while(continuation)
const candidates=pages.map(page=>{const info=page.imageinfo?.[0],meta=info?.extmetadata??{};return{pageId:page.pageid,title:page.title,width:info?.width??0,height:info?.height??0,mime:info?.mime??'',bytes:info?.size??0,thumbUrl:info?.thumburl,originalUrl:info?.url,descriptionUrl:info?.descriptionurl,license:clean(meta.LicenseShortName?.value),licenseUrl:clean(meta.LicenseUrl?.value),artist:clean(meta.Artist?.value||meta.Credit?.value),description:clean(meta.ImageDescription?.value)}}).filter(item=>item.thumbUrl&&item.originalUrl&&item.width>=1200&&item.height>=900&&/^image\/(jpeg|png)$/i.test(item.mime)&&allowedLicense.test(item.license)).sort((left,right)=>left.title.localeCompare(right.title)).slice(0,24)
const records=[],failures=[]
for(const[index,item]of candidates.entries()){
  const extension=item.mime==='image/png'?'.png':'.jpg',fileName=`wm_profile_${String(index+1).padStart(3,'0')}${extension}`,localPath=join(imageDir,fileName);try{let bytes;try{bytes=await readFile(localPath);if(bytes.length<1024)throw new Error('partial file')}catch{const response=await fetchWithRetry(item.thumbUrl);bytes=Buffer.from(await response.arrayBuffer());await writeFile(localPath,bytes);await wait(1200)}records.push({...item,fileName,path:`data/face-db-real-research/wikimedia-profile-candidates/images/${fileName}`,downloadedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});process.stdout.write(`Ready ${index+1}/${candidates.length}: ${basename(fileName)}\n`)}catch(error){failures.push({title:item.title,descriptionUrl:item.descriptionUrl,error:error instanceof Error?error.message:String(error)});process.stderr.write(`Skipped ${index+1}/${candidates.length}: ${item.title}\n`)}
}
const manifest={createdAt:new Date().toISOString(),policyVersion:'HEADUP-WIKIMEDIA-PROFILE-CANDIDATES-1.0',source:{site:'Wikimedia Commons',category,categoryUrl:'https://commons.wikimedia.org/wiki/Category:Profile_views_of_people_(right)',api,selection:'direct category files; bitmap; source width>=1200 and height>=900; free-license allowlist; first 24 title-sorted records',download:'Commons 1400px derivative; resumable; source URL and per-file license retained'},counts:{apiFiles:pages.length,eligible:candidates.length,downloaded:records.length,failed:failures.length},purpose:'New real-profile breadth validation only; not bundled with the app',records,failures};await writeFile(join(outputDir,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);process.stdout.write(`${JSON.stringify({manifest:join(outputDir,'manifest.json'),counts:manifest.counts,licenses:Object.fromEntries(Object.entries(Object.groupBy(records,item=>item.license)).map(([key,items])=>[key,items.length]))},null,2)}\n`)
