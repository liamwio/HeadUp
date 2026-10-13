const blockingFlags=new Set(['分辨率偏低','光线不足','画面过曝','对比度偏低','画面模糊','疑似低清放大','无法完成像素质检'])
export function isPhotoQualityAcceptable(quality:{score:number;flags:string[]}){return quality.score>=60&&!quality.flags.some(flag=>blockingFlags.has(flag))}
