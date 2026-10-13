import type {IncomingMessage,ServerResponse} from 'node:http'
import {createReadStream} from 'node:fs'
import {stat,realpath} from 'node:fs/promises'
import {resolve,relative,isAbsolute,extname} from 'node:path'
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.wasm':'application/wasm','.onnx':'application/octet-stream','.task':'application/octet-stream','.tflite':'application/octet-stream','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'}
export function staticApp(directory:string){
  const root=resolve(directory),inside=(path:string)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')}
  return async(req:IncomingMessage,res:ServerResponse)=>{
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return}
    try{
      let path=decodeURIComponent(new URL(req.url??'/','http://internal').pathname).replace(/\\/g,'/');if(path==='/')path='/index.html'
      const target=resolve(root,'.'+path);if(path.includes('\0')||path.split('/').some(part=>part.startsWith('.'))||!types[extname(target)]||!inside(target))throw new Error('outside')
      const resolved=await realpath(target);if(!inside(resolved))throw new Error('symlink outside');const info=await stat(resolved);if(!info.isFile())throw new Error('not_file')
      res.writeHead(200,{'Content-Type':types[extname(resolved)]??'application/octet-stream','Content-Length':info.size,'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Cache-Control':['.html','.json','.webmanifest'].includes(extname(resolved))?'no-cache':'public, max-age=3600'})
      if(req.method==='HEAD'){res.end();return}const stream=createReadStream(resolved);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)
    }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('页面不存在。请先构建应用。')}
  }
}
