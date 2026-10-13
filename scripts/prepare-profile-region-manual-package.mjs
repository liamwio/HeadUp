import{readdir,mkdir,writeFile}from'node:fs/promises'
import{join,relative}from'node:path'
import{fileURLToPath}from'node:url'
import sharp from'sharp'

const root=fileURLToPath(new URL('../',import.meta.url)),sourceDir=join(root,'data','face-db-real-research','images','face-research-lab-london-v5'),outputDir=join(root,'data','manual-test','profile-region-truth-v1'),outputPath=join(outputDir,'manifest.json')
const files=(await readdir(sourceDir)).filter(name=>/_right_profile\.jpg$/i.test(name)).sort()
if(files.length!==102)throw new Error(`Expected 102 right profiles, found ${files.length}`)
const selected=Array.from({length:30},(_,index)=>files[Math.round(index*(files.length-1)/29)])
if(new Set(selected).size!==30)throw new Error('Deterministic selection produced duplicates')
const cases=[]
for(const[index,name]of selected.entries()){
  const path=join(sourceDir,name),metadata=await sharp(path).metadata()
  if(!metadata.width||!metadata.height)throw new Error(`Missing dimensions: ${name}`)
  cases.push({reviewId:`PROFILE-REGION-${String(index+1).padStart(2,'0')}`,dataset:'london_highres_confirmation',view:'right_profile',path:relative(root,path).replaceAll('\\','/'),sourceResolution:`${metadata.width}×${metadata.height}`,expectedRegions:['forehead','nasalDorsum','maxillarySupport','mandibularChin']})
}
const manifest={policyVersion:'HEADUP-PROFILE-REGION-MANUAL-PACKAGE-1.0',createdAt:new Date().toISOString(),source:{name:'Face Research Lab London Set local retained research package',availableSubjects:102,imagesCopied:false},selection:'30 deterministic evenly spaced entries from the filename-sorted 102-subject right-profile cohort; frozen before manual labels',counts:{subjects:30,images:30,regions:120},cases,privacy:{imagesCopied:false,exportUsesPseudonymousReviewIds:true,sourcePathsRemainLocal:true}}
await mkdir(outputDir,{recursive:true});await writeFile(outputPath,`${JSON.stringify(manifest,null,2)}\n`);process.stdout.write(`${JSON.stringify({outputPath,counts:manifest.counts,first:cases[0].reviewId,last:cases.at(-1).reviewId},null,2)}\n`)
