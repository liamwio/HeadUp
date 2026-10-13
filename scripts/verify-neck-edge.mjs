import { readFile, mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { createServer } from 'vite'

// Uses frozen model landmarks, never the manually corrected neck coordinates.
const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'})
const output='docs/neck-edge-v3'
const flagged=new Set([1,3,7,12,13,14,15,16,17,21,23,24,26,29,30].map(n=>`PROFILE-REGION-${String(n).padStart(2,'0')}`))
try {
  const {traceProfileNeckEdge}=await server.ssrLoadModule('/src/lib/profileNeckEdge.ts')
  const source=JSON.parse(await readFile('data/manual-test/profile-region-assisted-v1/manual-review-v1.2.json','utf8'))
  const manifest=JSON.parse(await readFile('data/manual-test/profile-region-truth-v1/manifest.json','utf8'))
  await mkdir(output,{recursive:true})
  const rows=[], tiles=[]
  for(const item of source.cases){
    const entry=manifest.cases.find(c=>c.reviewId===item.reviewId)
    const jaw=item.regions.mandibularChin.modelPoints, forehead=item.regions.forehead.modelPoints
    if(jaw.length!==7||forehead.length!==6){rows.push({id:item.reviewId,status:'missing',reason:'No frozen model landmarks'});continue}
    const points=Array.from({length:39},()=>({x:.5,y:.5}))
    jaw.forEach((p,i)=>points[4+i]=p);forehead.forEach((p,i)=>points[12+i]=p)
    const {data,info}=await sharp(entry.path).resize({width:720,height:720,fit:'inside'}).ensureAlpha().raw().toBuffer({resolveWithObject:true})
    const started=performance.now(), result=traceProfileNeckEdge({width:info.width,height:info.height,data},points,'right'), runtimeMs=performance.now()-started
    const flipped=await sharp(entry.path).flop().resize({width:info.width,height:info.height}).ensureAlpha().raw().toBuffer()
    const mirror=traceProfileNeckEdge({width:info.width,height:info.height,data:flipped},points.map(p=>({x:1-p.x,y:p.y})),'left')
    const mirrorError=Math.max(0,...result.points.map((p,i)=>Math.hypot(1-p.x-mirror.points[i].x,p.y-mirror.points[i].y)))
    rows.push({id:item.reviewId,image:entry.path,...result,runtimeMs,mirrorError,mirrorAngleDifference:result.angleDegrees!==null&&mirror.angleDegrees!==null?Math.abs(result.angleDegrees-mirror.angleDegrees):null})
    const line=(ps,color,dash='')=>`<polyline points="${ps.map(p=>`${p.x*info.width},${p.y*info.height}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3" ${dash?'stroke-dasharray="8 6"':''}/>`
    const overlay=`<svg width="${info.width}" height="${info.height}">${line(jaw,'#50dcea')}${line(result.points,result.status==='traced'?'#24efa7':'#ffce58',result.status==='weak'?'dash':'')}<circle cx="${result.points[0]?.x*info.width}" cy="${result.points[0]?.y*info.height}" r="4" fill="#ffffff" stroke="#157454"/><rect x="12" y="12" width="480" height="68" rx="10" fill="#162827" fill-opacity=".9"/><text x="24" y="39" fill="white" font-family="Arial" font-size="20">${item.reviewId} | ${result.status} | ${result.angleDegrees?.toFixed(2)??'candidate'} deg</text><text x="24" y="63" fill="white" font-family="Arial" font-size="14">V3: continuous chin-to-neck edge / WHITE start</text></svg>`
    const png=await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).composite([{input:Buffer.from(overlay)}]).png().toBuffer()
    await writeFile(`${output}/${item.reviewId}.png`,png)
    if(tiles.length<6)tiles.push(await sharp(png).resize(480,480).toBuffer())
  }
  const valid=rows.filter(r=>r.status==='traced'), angles=valid.map(r=>r.angleDegrees)
  const report={generatedAt:new Date().toISOString(),method:'Frozen neural-model jaw ROI + image-edge dynamic path; no manual neck labels',counts:{total:rows.length,traced:valid.length,weak:rows.filter(r=>r.status==='weak').length,missing:rows.filter(r=>r.status==='missing').length},angleRange:angles.length?[Math.min(...angles),Math.max(...angles)]:null,maxMirrorError:Math.max(...rows.map(r=>r.mirrorError??0)),limitations:['These are engineering/visual checks, not an accuracy validation against independent truth.','Frozen model ROIs reused; not a new full neural inference benchmark.','Mirrored photos test orientation parity, not independent left-view generalization.','Old manual coordinates were not used for fitting, selection or accuracy scoring.'],rows}
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2))
  await sharp({create:{width:1440,height:960,channels:3,background:'#f4f4f1'}}).composite(tiles.map((input,i)=>({input,left:(i%3)*480,top:Math.floor(i/3)*480}))).png().toFile(`${output}/comparison.png`)
  const allTiles=await Promise.all(rows.filter(r=>r.image).map(async r=>sharp(`${output}/${r.id}.png`).resize(300,300).toBuffer()))
  await sharp({create:{width:1500,height:Math.ceil(allTiles.length/5)*300,channels:3,background:'#f4f4f1'}}).composite(allTiles.map((input,i)=>({input,left:(i%5)*300,top:Math.floor(i/5)*300}))).png().toFile(`${output}/all-cases.png`)
  await writeFile(`${output}/index.html`,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>颏下至颈部连续描线 V3</title><style>body{margin:24px;background:#f5f6f3;font:16px/1.6 system-ui;color:#193833}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:20px}img{width:100%}figure{margin:0;background:white;padding:12px;border-radius:14px}.flagged{outline:2px solid #b18444}h1{font-size:24px}</style><h1>颏下至颈部 · 连续描线 V3</h1><p>绿色：新连续轮廓　白点：图像校正起点　青色：原下颌模型线　黄色虚线：待核对候选</p><p>金色边框为你指出的15张。旧红线不再默认显示。追踪完成不等于准确性通过；无需人工重新绘制。</p><p>${JSON.stringify(report.counts)}</p><main>${rows.map(r=>`<figure class="${flagged.has(r.id)?'flagged':''}">${r.image?`<img loading="lazy" alt="${r.id} 颏下至前颈自动轮廓" src="${r.id}.png">`:''}<figcaption>${r.id} · ${r.status==='traced'?'自动追踪已生成':r.status==='weak'?'候选待核对':'缺少既有模型点，本轮未运行'}${r.angleDegrees!=null?` · ${r.angleDegrees.toFixed(2)}°（前颈段方向，非整条曲线夹角）`:''}</figcaption>${r.image?`<a href="../neck-edge-v2/${r.id}.png" target="_blank">查看上一版对照</a>`:''}</figure>`).join('')}</main></html>`)
  console.log(JSON.stringify({...report,rows:undefined},null,2))
}finally{await server.close()}
