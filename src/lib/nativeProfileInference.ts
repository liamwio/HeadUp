import * as ort from 'onnxruntime-web/wasm'
import { traceProfileNeckBitmap } from './profileNeckEdge'
import { refineProfileJawBitmap } from './profileJawRefinement'
import { PROFILE_JAW_REFINEMENT_ENABLED } from './productFeatures'
import type { FaceDetection } from './faceDetector'
import { detectFacesFromBitmap } from './faceDetector'
import { computeProfileGeometry } from './profileGeometry'
import { nativeProfileLandmarkRejection, nativeProfileOutputRejection, validNormalizedProfileOutput } from './profileInferenceValidation'
import type { NativeProfileResult, PoseValidation } from '../types'

const MODEL_PATH = '/models/menpo39-profile-v1.onnx'
const MODEL_VERSION = 'HEADUP-MENPO39-ONNX-1.0'
const CROP_VERSION = 'HEADUP-MENPO39-YUNET-CROP-CALIBRATION-1.0'
const REFINER_VERSION='HEADUP-MENPO39-NORMALIZED-MULTISCALE-REFINERS-V1'
const INPUT_SIZE = 224
const MINIMUM_YUNET_SCORE = .85
const MINIMUM_CONFIDENCE_P10 = 0
const CROP = {
  left: { factor: 1.138812414528869, shiftX: 0.03847504237478136, shiftY: 0.11833929151974497 },
  right: { factor: 1.1504958141994608, shiftX: -0.03945996063163659, shiftY: 0.12225221823707466 },
} as const

let sessionPromise: Promise<ort.InferenceSession> | undefined
const refinerSessionPromises:Record<string,Promise<ort.InferenceSession>>={}
function getSession() {
  sessionPromise ??= ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }).catch(error=>{sessionPromise=undefined;throw error})
  return sessionPromise
}
function getRefinerSession(name:string){refinerSessionPromises[name]??=ort.InferenceSession.create(`/models/menpo39-${name}-refiner-v1.onnx`,{executionProviders:['wasm'],graphOptimizationLevel:'all'}).catch(error=>{delete refinerSessionPromises[name];throw error});return refinerSessionPromises[name]}

export type NativeProfileCrop = { x: number; y: number; side: number; orientation: 'left' | 'right' }

export function nativeProfileCropFromDetection(detection: FaceDetection, bitmapWidth: number, bitmapHeight: number, orientation: 'left' | 'right'): NativeProfileCrop {
  const detectorScale = 320 / Math.max(bitmapWidth, bitmapHeight)
  const x = detection.x / detectorScale
  const y = detection.y / detectorScale
  const width = detection.width / detectorScale
  const height = detection.height / detectorScale
  const detectorSide = Math.max(width, height)
  const params = CROP[orientation]
  const side = detectorSide * params.factor
  const centerX = x + width / 2 + params.shiftX * detectorSide
  const centerY = y + height / 2 + params.shiftY * detectorSide
  return { x: centerX - side / 2, y: centerY - side / 2, side, orientation }
}

function percentile10(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * .1) - 1)
  return sorted[index]
}

function makeCropTensor(bitmap:ImageBitmap,crop:{x:number;y:number;side:number},size:number){
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('profile_crop_canvas_unavailable')
  context.fillStyle = '#808080'
  context.fillRect(0, 0, size, size)
  context.drawImage(bitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size)
  const pixels = context.getImageData(0, 0, size, size).data
  const channelSize = size * size
  const data = new Float32Array(channelSize * 3)
  const mean = [.485, .456, .406]
  const std = [.229, .224, .225]
  for (let index = 0; index < channelSize; index++) {
    const rgba = index * 4
    data[index] = (pixels[rgba] / 255 - mean[0]) / std[0]
    data[channelSize + index] = (pixels[rgba + 1] / 255 - mean[1]) / std[1]
    data[channelSize * 2 + index] = (pixels[rgba + 2] / 255 - mean[2]) / std[2]
  }
  return new ort.Tensor('float32', data, [1, 3, size, size])
}
function makeTensor(bitmap:ImageBitmap,crop:NativeProfileCrop){return makeCropTensor(bitmap,crop,INPUT_SIZE)}

const refinerConfigs={nasalLabial:{indices:[17,19,20,21,27],inputSize:128,minimumFaceDiagonalFactor:.30,boxExpansion:1.8},mentolabial:{indices:[33,11,10],inputSize:128,minimumFaceDiagonalFactor:.24,boxExpansion:2},mandibularBorder:{indices:[4,5,6,7,8],inputSize:256,minimumFaceDiagonalFactor:.90,boxExpansion:2}}as const
export function nativeProfileLocalCrop(landmarks:Array<{x:number;y:number}>,indices:readonly number[],minimumFaceDiagonalFactor:number,boxExpansion:number){const selected=indices.map(index=>landmarks[index]),xs=selected.map(point=>point.x),ys=selected.map(point=>point.y),allXs=landmarks.map(point=>point.x),allYs=landmarks.map(point=>point.y),faceDiagonal=Math.hypot(Math.max(...allXs)-Math.min(...allXs),Math.max(...allYs)-Math.min(...allYs)),side=Math.max((Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)))*boxExpansion,faceDiagonal*minimumFaceDiagonalFactor,8),centerX=(Math.min(...xs)+Math.max(...xs))/2,centerY=(Math.min(...ys)+Math.max(...ys))/2;return{x:centerX-side/2,y:centerY-side/2,side}}
async function refineLandmarks(bitmap:ImageBitmap,landmarks:Array<{x:number;y:number;z:number}>){const started=performance.now(),pixels=landmarks.map(point=>({x:point.x*bitmap.width,y:point.y*bitmap.height})),entries=Object.entries(refinerConfigs)as Array<[keyof typeof refinerConfigs,(typeof refinerConfigs)[keyof typeof refinerConfigs]]>,runs=await Promise.all(entries.map(async([name,config])=>{const crop=nativeProfileLocalCrop(pixels,config.indices,config.minimumFaceDiagonalFactor,config.boxExpansion),session=await getRefinerSession(name),output=await session.run({[session.inputNames[0]]:makeCropTensor(bitmap,crop,config.inputSize)}),coordinates=output.coordinates?.data;if(!validNormalizedProfileOutput(coordinates,config.indices.length*2))throw new Error(`${name}_refiner_output_invalid`);return{name,config,crop,coordinates}})),refined=landmarks.map(point=>({...point}));for(const run of runs)for(const[position,index]of run.config.indices.entries()){const localX=(run.crop.x+Number(run.coordinates[position*2])*run.crop.side)/bitmap.width,localY=(run.crop.y+Number(run.coordinates[position*2+1])*run.crop.side)/bitmap.height;refined[index].x=(refined[index].x+localX)/2;refined[index].y=(refined[index].y+localY)/2}return{landmarks:refined,runtimeMs:Math.round((performance.now()-started)*10)/10}}

export async function inferNativeProfileFromBitmap(bitmap: ImageBitmap, pose: PoseValidation): Promise<NativeProfileResult> {
  const started = performance.now()
  const orientation = pose.estimatedPose === 'right_profile' ? 'right' : pose.estimatedPose === 'left_profile' ? 'left' : null
  if (pose.status !== 'pass' || !orientation) return { status: 'unavailable', reason: 'profile_pose_gate_not_passed' }
  try {
    const detectionSummary = await detectFacesFromBitmap(bitmap)
    const detection = detectionSummary.detections[0]
    if (!detection || detection.score < MINIMUM_YUNET_SCORE) return { status: 'unavailable', reason: 'profile_face_score_below_0.85' }
    const crop = nativeProfileCropFromDetection(detection, bitmap.width, bitmap.height, orientation)
    const session=await getSession()
    const tensor=makeTensor(bitmap,crop)
    const outputs=await session.run({[session.inputNames[0]]:tensor})
    const coordinates = outputs.coordinates?.data
    const confidence = outputs.confidence?.data
    const outputRejection=nativeProfileOutputRejection(coordinates,confidence)
    if(outputRejection||!coordinates||!confidence)return {status:'unavailable',reason:outputRejection??'native39_output_contract_failed'}
    const pointConfidence = Array.from(confidence, Number)
    const confidenceP10 = percentile10(pointConfidence)
    if (confidenceP10 < MINIMUM_CONFIDENCE_P10) return { status: 'unavailable', reason: 'native39_confidence_below_threshold', confidenceP10 }
    let landmarks = Array.from({ length: 39 }, (_, index) => ({
      x: (crop.x + Number(coordinates[index * 2]) * crop.side) / bitmap.width,
      y: (crop.y + Number(coordinates[index * 2 + 1]) * crop.side) / bitmap.height,
      z: 0,
    }))
    const initialRejection=nativeProfileLandmarkRejection(landmarks,orientation)
    if(initialRejection)return {status:'unavailable',reason:initialRejection,confidenceP10}
    const refined=await refineLandmarks(bitmap,landmarks);landmarks=refined.landmarks
    const refinedRejection=nativeProfileLandmarkRejection(landmarks,orientation)
    if(refinedRejection)return {status:'unavailable',reason:refinedRejection,confidenceP10}
    const landmarkGeometry = computeProfileGeometry({
      landmarks: landmarks.map(({ x, y }) => ({ x: x * bitmap.width, y: y * bitmap.height })),
      orientation,
      headAxisAngleDegrees: pose.roll,
    })
    if (landmarkGeometry.status !== 'measured') return { status: 'unavailable', reason: landmarkGeometry.reason, confidenceP10 }
    const geometry=landmarkGeometry.geometry
    // Optional photographic references must not discard the accepted facial
    // points/lines/measurements if their pixel tracing fails.
    let neckEdge:NativeProfileResult['neckEdge'],jawRefinement:NativeProfileResult['jawRefinement']
    try { neckEdge=traceProfileNeckBitmap(bitmap, landmarks, orientation) } catch { /* Omit unavailable reference. */ }
    if (PROFILE_JAW_REFINEMENT_ENABLED) {
      try { jawRefinement=refineProfileJawBitmap(bitmap, landmarks, orientation) } catch { /* Omit unavailable reference. */ }
    }
    return {
      status: 'measured', orientation, landmarks, pointConfidence, confidenceP10,
      neckEdge, jawRefinement,
      geometry,landmarkDerivedGeometry:geometry,headAxisAngleDegrees:pose.roll, measuredMetricCount: 7,
      modelVersion: MODEL_VERSION, cropVersion: CROP_VERSION,
      geometrySource:'landmark_derived',geometryModelVersion:'HEADUP-PROFILE-POINT-LINE-1.0',
      refinerVersion:REFINER_VERSION,refinerRuntimeMs:refined.runtimeMs,
      runtimeMs: Math.round((performance.now() - started) * 10) / 10,
    }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? `native39_runtime:${error.message}` : 'native39_runtime_failed' }
  }
}
