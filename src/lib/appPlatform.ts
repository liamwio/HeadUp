/** Presentation only. Never use the user agent to grant permissions or trust a server. */
export const isHeadUpAndroid=()=>typeof navigator!=='undefined'&&/HeadUpAndroid\/[0-9.]+/.test(navigator.userAgent)
export const isHeadUpIOS=()=>typeof navigator!=='undefined'&&/HeadUpiOS\/[0-9.]+/.test(navigator.userAgent)
export const localStorageContext=()=>isHeadUpAndroid()?'此Android应用':isHeadUpIOS()?'此iOS应用':'当前浏览器'
export const localArchiveNotice=()=>(isHeadUpAndroid()||isHeadUpIOS())?`照片和结果保存在${localStorageContext()}中，能打开此应用的人可见。卸载应用、清除应用数据或换设备可能失去记录，请定期下载加密备份。`:'照片和结果保存在当前浏览器，同一浏览器使用者可见。换设备或清理浏览器可能失去记录，请定期下载加密备份。'
