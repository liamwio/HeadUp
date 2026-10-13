import {readFile,writeFile,mkdir} from 'node:fs/promises'
import sharp from 'sharp'
import {createServer} from 'vite'
const output='docs/jaw-refinement-v1'
const server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true},server:{middlewareMode:true},appType:'custom',logLevel:'error'})
try{
  const {refineProfileJaw}=await server.ssrLoadModule('/src/lib/profileJawRefinement.ts')
  const {traceProfileNeckEdge}=await server.ssrLoadModule('/src/lib/profileNeckEdge.ts')
  const source=JSON.parse(await readFile('data/manual-test/profile-region-assisted-v1/manual-review-v1.2.json','utf8'))
  const necks=JSON.parse(await readFile('docs/neck-edge-v3/results.json','utf8')).rows
  await mkdir(output,{recursive:true})
  const rows=[],tiles=[]
  for(const item of source.cases){
    const neck=necks.find(r=>r.id===item.reviewId),jaw=item.regions.mandibularChin.modelPoints,forehead=item.regions.forehead.modelPoints
    if(!neck?.image||jaw.length!==7||forehead.length!==6){rows.push({id:item.reviewId,status:'missing',reason:'无既有模型点'});continue}
    const points=Array.from({length:39},()=>({x:.5,y:.5}));jaw.forEach((p,i)=>points[4+i]=p);forehead.forEach((p,i)=>points[12+i]=p)
    const before=JSON.stringify(points),{data,info}=await sharp(neck.image).resize({width:720,height:720,fit:'inside'}).ensureAlpha().raw().toBuffer({resolveWithObject:true})
    const start=performance.now(),result=refineProfileJaw({width:info.width,height:info.height,data},points,'right'),runtimeMs=performance.now()-start
    const flipped=await sharp(neck.image).flop().resize({width:info.width,height:info.height}).ensureAlpha().raw().toBuffer()
    const mirror=refineProfileJaw({width:info.width,height:info.height,data:flipped},points.map(p=>({x:1-p.x,y:p.y})),'left')
    const mirrorError=Math.max(0,...result.points.map((p,i)=>Math.hypot(1-p.x-mirror.points[i].x,p.y-mirror.points[i].y)))
    const neckAfter=traceProfileNeckEdge({width:info.width,height:info.height,data},points,'right')
    rows.push({id:item.reviewId,image:neck.image,...result,runtimeMs,mirrorError,modelPointsUnchanged:before===JSON.stringify(points),neckUnchanged:JSON.stringify(neck.points)===JSON.stringify(neckAfter.points)})
    const line=(ps,color,dash=false)=>`<polyline points="${ps.map(p=>`${p.x*info.width},${p.y*info.height}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" ${dash?'stroke-dasharray="6 5"':''}/>`
    const overlay=(old)=>`<svg width="${info.width}" height="${info.height}">${old?line(jaw,'#e2a163',true):''}${line(result.points,'#24cce4')}${line(neck.points,'#39df9b')}<rect x="12" y="12" width="470" height="65" rx="10" fill="#162827"/><text x="24" y="38" fill="white" font-family="Arial" font-size="19">${item.reviewId} | ${result.status}</text><text x="24" y="62" fill="white" font-family="Arial" font-size="14">CYAN refined jaw / GREEN unchanged neck${old?' / DASH old':''}</text></svg>`
    for(const old of [false,true])await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).composite([{input:Buffer.from(overlay(old))}]).png().toFile(`${output}/${item.reviewId}${old?'-compare':''}.png`)
    tiles.push(await sharp(`${output}/${item.reviewId}-compare.png`).resize(300,300).toBuffer())
  }
  const report={generatedAt:new Date().toISOString(),counts:{total:rows.length,refined:rows.filter(r=>r.status==='refined').length,conservative:rows.filter(r=>r.status==='conservative').length,missing:rows.filter(r=>r.status==='missing').length},neckUnchanged:rows.filter(r=>r.image).every(r=>r.neckUnchanged),maxMirrorError:Math.max(...rows.map(r=>r.mirrorError??0)),limitations:['Model-local image refinement; no independent ground truth accuracy claim.','Human corrected lines not used.','Frozen existing landmarks, not a full new neural inference benchmark.'],rows}
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2))
  await sharp({create:{width:1500,height:Math.ceil(tiles.length/5)*300,channels:3,background:'#f5f5f1'}}).composite(tiles.map((input,i)=>({input,left:i%5*300,top:Math.floor(i/5)*300}))).png().toFile(`${output}/all-cases.png`)
  await writeFile(`${output}/index.html`,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>下颌线细化</title><style>body{font:16px/1.6 system-ui;margin:24px;background:#f5f6f3;color:#193833}h1{font-size:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:20px}figure{margin:0;background:white;border-radius:12px;padding:12px}img{width:100%}</style><h1>下颌线细化 · 未采用</h1><p role="status" style="padding:16px;background:#fff0da;border:1px solid #ba8244;border-radius:10px"><strong>人工核对反馈：细化不如原线准确。主程序已恢复原下颌线，V3颈线不变。</strong> 本页仅保留实验对照，不是当前默认结果。<a href="/">查看主程序</a></p><p>青色：新版下颌线　绿色：已确认颈线（不修改）。边界较淡处采用保守描线，不代表骨性真值。</p><p>细化 ${report.counts.refined} · 保守 ${report.counts.conservative} · 缺少定位 ${report.counts.missing}</p><main>${rows.map(r=>`<figure>${r.image?`<img alt="${r.id} 自动下颌线" src="${r.id}.png">`:''}<figcaption>${r.id} · ${r.status==='refined'?'图像细化':r.status==='conservative'?'边界较淡 · 保守描线':'缺少既有模型点'}</figcaption>${r.image?`<details><summary>与原线对照</summary><img loading="lazy" src="${r.id}-compare.png" alt="橙色虚线为原下颌线"></details>`:''}</figure>`).join('')}</main></html>`)
  console.log(JSON.stringify({...report,rows:undefined},null,2))
}finally{await server.close()}
