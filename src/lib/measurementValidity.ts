/** Product release decisions, separate from historical research calculations.
 * Empty registries are intentional: no matching capture-protocol calibration
 * has yet established a population reference or a repeatable face category. */
export const VALIDATED_PHOTO_REFERENCE_CODES: ReadonlySet<string> = new Set()
export const FACE_SHAPE_CLASSIFICATION_VALIDATED = false
export const SYMMETRY_MEASUREMENT_VALIDATED = false
export const PROFILE_HEAD_AXIS_VALIDATED = false
export const PROFILE_DIRECTION_VALIDATED = false

export const EYE_TILT_CALIBRATION_PENDING = '双眼倾斜符号已修正；旧公式误差不适用，当前仅记录角度，待同协议复拍校准。'
export const PHOTO_REFERENCE_PENDING = '参考范围尚未按相同点位和拍摄方法验证，本次仅记录数值。'
export const PROFILE_AXIS_PENDING = '侧面头位参照尚未验证，本次不计算相对头位的下颌倾斜角。'
