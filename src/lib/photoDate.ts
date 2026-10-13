import {parse} from 'exifr'
import type {Capture} from '../types'
import {localDate,validDate} from '../family/dates'

/** Keep the calendar date written by the camera; converting EXIF to UTC can change the day. */
export function exifCalendarDate(value:unknown,today=localDate()):string|undefined {
  if(typeof value!=='string')return
  const match=/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T]|$)/.exec(value.trim())
  if(!match)return
  const date=match.slice(1).join('-')
  return validDate(date)&&date<=today?date:undefined
}
export async function readPhotoDate(file:Blob):Promise<string|undefined>{
  try {
    if(file.size>30*1024*1024)return
    let bytes=new Uint8Array(await file.arrayBuffer())
    // WebP stores EXIF as a RIFF chunk; hand its TIFF payload to the same parser.
    const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end))
    if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'){
      const data=new DataView(bytes.buffer);let found=false
      for(let offset=12;offset+8<=bytes.length;){
        const size=data.getUint32(offset+4,true),end=offset+8+size
        if(end>bytes.length)return
        if(ascii(offset,offset+4)==='EXIF'){let start=offset+8;if(ascii(start,start+6)==='Exif\0\0')start+=6;bytes=bytes.slice(start,end);found=true;break}
        offset=end+(size%2)
      }
      if(!found)return
    }
    const metadata=await parse(bytes,{pick:['DateTimeOriginal','CreateDate'],reviveValues:false,gps:false})
    return exifCalendarDate(metadata?.DateTimeOriginal)??exifCalendarDate(metadata?.CreateDate)
  }catch{return undefined}
}
export function captureDateSummary(captures:Capture[]) {
  const photos=captures.filter(c=>c.url)
  const dates=photos.map(c=>c.photoDate??(c.source==='live'&&c.capturedAt?localDate(new Date(c.capturedAt)):''))
  if(!photos.length)return {date:'',message:''}
  const known=[...new Set(dates.filter(Boolean))]
  if(known.length>1)return {date:'',message:'照片的拍摄日期不一致，请核对后填写本次记录日期。'}
  if(dates.some(d=>!d))return {date:'',message:'部分照片没有可读取的拍摄日期，请填写本次记录日期。'}
  return {date:known[0],message:photos.every(c=>c.source==='live')?'已自动记录拍照日期。':'已读取照片拍摄日期。'}
}
