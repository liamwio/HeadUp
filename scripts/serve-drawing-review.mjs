import {createServer} from 'vite'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const root=resolve('.'),folder=join(root,'data/validation/llm-drawing-review-2026-09-22'),manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8')),ids=new Set(manifest.cases.map(c=>c.id))
await mkdir(join(folder,'results'),{recursive:true});await mkdir(join(folder,'sheets'),{recursive:true})
const server=await createServer({configFile:join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:5197,strictPort:true},plugins:[{name:'drawing-review-output',configureServer(vite){vite.middlewares.use('/__drawing_review_result',async(req,res)=>{
 if(req.method!=='POST'||req.headers.origin!=='http://127.0.0.1:5197'){res.statusCode=403;res.end();return}
 try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw Error('payload_too_large');chunks.push(chunk)}
 const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!ids.has(payload.id)||typeof payload.sheet!=='string'||!payload.sheet.startsWith('data:image/png;base64,'))throw Error('invalid_case')
 const png=Buffer.from(payload.sheet.split(',')[1],'base64');if(png.length>10*1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('invalid_png')
 const metadata=JSON.stringify(payload.result,null,2);if(metadata.length>2*1024*1024)throw Error('metadata_too_large')
 await writeFile(join(folder,'sheets',payload.id+'.png'),png);await writeFile(join(folder,'results',payload.id+'.json'),metadata)
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({saved:true,id:payload.id}));console.log('Saved '+payload.id)
 }catch(error){res.statusCode=400;res.end(JSON.stringify({error:String(error.message)}))}
 })}}]})
await server.listen();console.log('Review UI: http://127.0.0.1:5197/.tmp/drawing-review.html')
