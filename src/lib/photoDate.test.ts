import {it,expect} from 'vitest'
import sharp from 'sharp'
import {exifCalendarDate,readPhotoDate,captureDateSummary} from './photoDate'
import type {Capture} from '../types'
it.each(['jpeg','png','webp'] as const)('reads the original calendar day from real %s EXIF before image conversion',async format=>{
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#926374'}}).withExif({IFD2:{DateTimeOriginal:'2020:06:15 00:30:00',DateTimeDigitized:'2021:07:16 12:00:00',OffsetTimeOriginal:'+09:00'}}).toFormat(format).toBuffer()
  expect(await readPhotoDate(new Blob([new Uint8Array(bytes)]))).toBe('2020-06-15')
})
it('leaves missing and malformed dates unknown rather than using the import or file-modification date',async()=>{
  expect(await readPhotoDate(new File(['broken'],'photo.jpg',{lastModified:Date.now()}))).toBeUndefined()
  expect(exifCalendarDate('2020:02:30 12:00:00')).toBeUndefined();expect(exifCalendarDate('2099:01:01 00:00:00')).toBeUndefined()
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#926374'}}).jpeg().toBuffer()
  expect(await readPhotoDate(new Blob([new Uint8Array(bytes)]))).toBeUndefined()
})
it('fills matching capture dates and requires review for missing or conflicting dates',()=>{
  const photo=(date?:string):Capture=>({id:'front',label:'',hint:'',eyebrow:'',url:'blob:test',photoDate:date,source:'upload'})
  expect(captureDateSummary([photo('2020-06-15'),photo('2020-06-15')]).date).toBe('2020-06-15')
  expect(captureDateSummary([photo('2020-06-15'),photo('2020-06-16')]).date).toBe('')
  expect(captureDateSummary([photo('2020-06-15'),photo()]).date).toBe('')
  expect(captureDateSummary([{...photo(),source:'live',capturedAt:'2020-06-15T12:00:00'}]).date).toBe('2020-06-15')
})
