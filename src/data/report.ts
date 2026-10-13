import type { Measurement } from '../types'

export const measurements: Measurement[] = [
  { code: 'FRONT-SYM-01', label: '整体对称性', value: '84 / 100', score: 84, note: '12 组左右关键点镜像残差', group: '对称', formula: '示例：median(12组镜像残差) ÷ IPD', landmarkIndices: '示例点对：33–263、133–362等；真人报告显示完整12组', confidenceBasis: '示例置信度只演示产品结构，不对应真实用户或准确率。' },
  { code: 'FRONT-RATIO-01', label: '可见脸长宽比', value: '1.36', score: 88, note: '可见脸高 ÷ 颧宽', group: '比例', formula: 'distance(10,152) ÷ distance(234,454)', landmarkIndices: '10/152/234/454', confidenceBasis: '示例置信度只演示产品结构，不对应真实用户或准确率。' },
  { code: 'FRONT-RATIO-07', label: '下脸高度占比', value: '39%', score: 91, note: '鼻基底至软组织颏点', group: '比例', formula: 'distance(2,152) ÷ distance(10,152)', landmarkIndices: '2/152/10', confidenceBasis: '示例置信度只演示产品结构，不对应真实用户或准确率。' },
  { code: 'FRONT-RATIO-03', label: '眼间距比', value: '0.96', score: 86, note: '内眼角距 ÷ 平均眼宽', group: '比例', formula: 'distance(133,362) ÷ mean(33–133,362–263)', landmarkIndices: '33/133/362/263', confidenceBasis: '示例置信度只演示产品结构，不对应真实用户或准确率。' },
  { code: 'PROFILE-ANGLE-01', label: '软组织面凸角', value: '168.2°', score: 78, note: '受鼻、唇、颏与拍摄姿态共同影响', group: '侧貌', formula: '示例：angle(nasal root, subnasale, soft-tissue pogonion)', landmarkIndices: '示例语义点；真人侧貌当前禁用', confidenceBasis: '仅为校准示例，不代表真人侧貌模型已通过。' },
  { code: 'PROFILE-ANGLE-06', label: '下颌缘倾斜代理', value: '24.6°', score: 74, note: '可见轮廓角，不替代影像学指标', group: '侧貌', formula: '示例：fitted visible jaw contour angle relative to head axis', landmarkIndices: '示例语义轮廓；真人侧貌当前禁用', confidenceBasis: '仅为校准示例，不代表真人侧貌模型已通过。' },
]

export const cannotDetermine = [
  '骨龄、剩余生长潜力和未来生长方向',
  '颅缝闭合状态、颅内结构和真实颅骨形状',
  'SNA、SNB、ANB、Wits 等影像学指标',
  '牙齿代偿、牙根位置、牙槽骨厚度和咬合关系',
  '真实下颌角、髁突、升支、下颌体和颅底结构',
  '仅由骨骼导致的偏颌或发育异常',
]

export const reportVersion = {
  algorithm: 'HU-GEO 1.3.0-point-line',
  norm: 'POINT-LINE-VALIDATION-PENDING-2026.09',
  copy: 'SAFE-COPY 1.3-point-line',
}
