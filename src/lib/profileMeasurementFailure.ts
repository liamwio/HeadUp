import type {PhotoQuality, PoseValidation} from '../types'
import {isPhotoQualityAcceptable} from './imageQuality'
import {PROFILE_MAXIMUM_ABSOLUTE_ROLL} from './poseRules'

/** User-facing stage of failure; never replace missing landmarks with estimates. */
export function profileMeasurementFailure(pose?:PoseValidation,quality?:PhotoQuality):string|undefined {
  if (!pose) return '侧面检测未完成，照片已保留，请重试检测。'
  if (pose.status !== 'pass' && pose.flags.includes('头部横向倾斜过大') && Number.isFinite(pose.roll)) {
    return `侧面姿态检查未通过：模型估计横向倾斜 ${Math.abs(pose.roll!).toFixed(1)}°，超过当前 ${PROFILE_MAXIMUM_ABSOLUTE_ROLL}° 限值，尚未进行关键点定位和测量。请保持头部自然竖直、手机端正后重拍；若原图看起来端正，需核查角度估计。`
  }
  if (pose.status !== 'pass') return `侧面拍摄检查未通过：${pose.flags.join('；') || '请保持完整侧面并重新拍摄。'}`
  if (quality && !isPhotoQualityAcceptable(quality)) return `照片质量检查未通过：${quality.flags.join('；') || '请在均匀光线下拍摄清晰照片。'}`
  const native=pose.nativeProfile
  if (native?.status === 'measured') return undefined
  const reason=native?.reason ?? ''
  if (reason.startsWith('native39_runtime')) return '侧面轮廓模型暂不可用；照片与已完成的拍摄检查已保留，可以重试检测。'
  if (reason === 'native39_landmarks_invalid') return '侧面关键点未能完整定位，或落在照片范围外。请完整拍入额头、鼻尖、嘴唇和下巴，留出边缘后重拍。'
  if (reason === 'native39_pose_direction_conflict') return '关键点方向与侧面方向不一致。请使用未镜像的原图，露出完整侧面后重试。'
  if (reason.startsWith('profile_face_score')) return '未能稳定定位侧面人脸。请让面部居中、适当靠近并避免头发遮挡。'
  if (reason.includes('geometry') || reason.includes('landmark_order') || reason.includes('collapsed_required') || reason.includes('face_height') || reason.includes('measurement_line')) return '已定位侧面关键点，但点位或测量线检查未通过，本次不生成读数。请保持自然闭唇、完整侧面并重拍。'
  return '侧面关键点定位未完成，本次未生成测量线和读数。照片已保留，可重试检测或更换清晰的侧面原图。'
}
