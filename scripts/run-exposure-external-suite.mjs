import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const projectDir=fileURLToPath(new URL('../',import.meta.url)),run=args=>new Promise((resolve,reject)=>{const child=execFile(process.execPath,args,{cwd:projectDir,windowsHide:true},error=>error?reject(error):resolve());child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr)})
try{await run(['--max-old-space-size=4096','scripts/prepare-transient-demographic-coverage.mjs']);await run(['scripts/run-exposure-external-browser-benchmark.mjs'])}finally{await run(['scripts/cleanup-transient-demographic-coverage.mjs'])}
