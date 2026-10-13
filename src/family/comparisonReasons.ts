export const COMPARISON_REASONS={
  reading_source:'两次读数的来源、点位公式或模型版本不同，保留原值但不计算差值',
  other_profile:'两次记录属于不同档案，不能比较',same_record:'请选两次不同的记录',revision:'这是同一次记录的不同分析版本，不是跨期成长记录',reused_photo:'两次使用了相同的照片文件，不能作为跨期比较',missing_view:'所选视角有照片缺失',side:'侧面方向不同或未确认，不能作为同侧比较',memory:'其中一次为生活留念，只查看照片',same_date:'同日记录不代表跨期成长变化',date_source:'原记录缺少拍摄日期的确认来源',version:'算法、误差依据或拍摄协议版本不同',device_missing:'拍摄设备未记录',device:'两次使用了不同设备',camera_missing:'使用的镜头未记录',camera:'前后摄像头不同',distance_missing:'拍摄距离未记录',distance:'拍摄距离不同',light_missing:'光线条件未记录',light:'两次光线条件不同',quality:'存在拍摄质量或姿态提示',uncalibrated:'拍摄条件记录接近，但该协议的真实跨期误差尚未验证；暂不判断发育进展',
} as const
export type ComparisonReason=keyof typeof COMPARISON_REASONS
