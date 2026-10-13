import {afterEach,expect,it,vi} from 'vitest'
import {isHeadUpAndroid,isHeadUpIOS,localArchiveNotice,localStorageContext} from './appPlatform'
import {cameraErrorMessage} from './liveCamera'
afterEach(()=>vi.unstubAllGlobals())
it('uses iOS application storage and permission wording in the native iOS shell',()=>{
  vi.stubGlobal('navigator',{userAgent:'AppleWebKit HeadUpiOS/1.1'})
  expect(isHeadUpIOS()).toBe(true);expect(isHeadUpAndroid()).toBe(false)
  expect(localStorageContext()).toBe('此iOS应用')
  expect(localArchiveNotice()).toContain('卸载应用')
  expect(cameraErrorMessage(new DOMException('denied','NotAllowedError'))).toContain('iPhone设置')
})
it.each([['HeadUpAndroid/1.1','此Android应用'],['Safari/605.1','当前浏览器']])('preserves %s platform wording', (userAgent,expected)=>{
  vi.stubGlobal('navigator',{userAgent});expect(localStorageContext()).toBe(expected)
  expect(isHeadUpIOS()).toBe(false)
})
