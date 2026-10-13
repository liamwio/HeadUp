import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectDir = fileURLToPath(new URL('../', import.meta.url))
const stagingRoot = join(projectDir, 'data', 'face-benchmark', '.staging')
const stagingDir = join(stagingRoot, 'menpo39-yunet-calibration')
const extractDir = join(stagingDir, 'extract')
const archivePath = join(stagingDir, 'menpo_challenge_trainset.zip')
const markerPath = join(stagingDir, '.headup-menpo39-yunet-calibration.json')
const runtimeDir = join(projectDir, 'data', 'face-benchmark', '.runtime', 'menpo39-onnx-export')
const modelPath = join(projectDir, 'public', 'models', 'menpo39-profile-v1.onnx')
const manifestPath = join(projectDir, 'public', 'models', 'menpo39-profile-v1.manifest.json')
const yunetPath = join(projectDir, 'public', 'models', 'face_detection_yunet_2026may.onnx')
const resultPath = join(projectDir, 'data', 'face-benchmark', 'menpo39-yunet-crop-calibration-result.json')
const scriptPath = join(projectDir, 'scripts', 'calibrate-menpo39-yunet-crop.py')
const url = 'https://drive.usercontent.google.com/download?id=1CUqs0n135lye6J6RM5FQXT_DIT45dKvP&export=download&confirm=t'
const expectedSha256 = '2b702bc178e88e1802506e1e7c4c5b78a07b86a4854b7918de3e040532723ea4'
const python = process.env.HEADUP_PYTHON || 'py'
const prefix = process.env.HEADUP_PYTHON ? [] : ['-3.11']
const exists = path => access(path, constants.F_OK).then(() => true, () => false)
const digestFile = async path => { const hash=createHash('sha256'); for await(const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
const runStreaming = (command,args,options) => new Promise((resolvePromise,rejectPromise)=>{const child=spawn(command,args,{...options,stdio:'inherit'});child.on('error',rejectPromise);child.on('exit',(code,signal)=>code===0?resolvePromise():rejectPromise(new Error(`Calibration failed with code ${code}, signal ${signal}`)))})

if (!resolve(stagingDir).startsWith(resolve(stagingRoot))) throw new Error('Unsafe staging path')
await rm(stagingDir,{recursive:true,force:true})
await mkdir(extractDir,{recursive:true})
await writeFile(markerPath,JSON.stringify({policyVersion:'HEADUP-MENPO39-YUNET-STAGING-1.0',createdAt:new Date().toISOString()},null,2))
try {
  if (!(await exists(join(runtimeDir,'cv2')))) {
    await execFileAsync(python,[...prefix,'-m','pip','install','--disable-pip-version-check','--quiet','--target',runtimeDir,'opencv-python-headless==4.12.0.88'],{maxBuffer:20*1024*1024,timeout:10*60*1000})
  }
  await execFileAsync('curl.exe',['--fail','--location','--silent','--show-error','--retry','4','--retry-all-errors','--connect-timeout','20','--max-time','1200','--user-agent','HeadUp-Profile-Eval/1.0','--output',archivePath,url],{maxBuffer:2*1024*1024,timeout:21*60*1000})
  const actual=await digestFile(archivePath)
  if(actual!==expectedSha256)throw new Error(`Menpo archive checksum mismatch: ${actual}`)
  process.stdout.write(`Verified Menpo archive: ${actual}\n`)
  const {stdout:listing}=await execFileAsync('tar.exe',['-tf',archivePath],{maxBuffer:50*1024*1024})
  const unsafe=listing.split(/\r?\n/).filter(Boolean).find(entry=>entry.startsWith('/')||entry.startsWith('\\')||entry.split(/[\\/]/).includes('..'))
  if(unsafe)throw new Error(`Unsafe archive entry: ${unsafe}`)
  await execFileAsync('tar.exe',['-xf',archivePath,'-C',extractDir],{maxBuffer:5*1024*1024,timeout:10*60*1000})
  await rm(archivePath,{force:true})
  await runStreaming(python,[...prefix,scriptPath,extractDir,modelPath,join(projectDir,'public','models','menpo39-profile-geometry-v1.onnx'),yunetPath,resultPath,manifestPath],{cwd:projectDir,env:{...process.env,PYTHONPATH:[runtimeDir,process.env.PYTHONPATH].filter(Boolean).join(';')}})
  const result=JSON.parse(await readFile(resultPath,'utf8'))
  if(!result.passesConditionalModelGates)process.stderr.write('Calibration completed but conditional model gates failed.\n')
  else if(!result.passesAllProductGates)process.stderr.write('Conditional model gates passed; broad capture coverage remains below product gate.\n')
} finally {
  const marker=JSON.parse(await readFile(markerPath,'utf8').catch(()=> '{}'))
  if(marker.policyVersion==='HEADUP-MENPO39-YUNET-STAGING-1.0')await rm(stagingDir,{recursive:true,force:true})
}
