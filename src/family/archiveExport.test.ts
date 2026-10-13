import {it,expect} from 'vitest'
import {selectArchiveRange,readableArchiveHtml,archivePreview} from './archiveExport'
import {archiveFixture} from './backupVolumes.fixture'
it('filters by recording date while retaining every revision, media and current plan',()=>{
  const archive=archiveFixture(),id=archive.profiles[0].id
  const selected=selectArchiveRange(archive,id,{from:'2026-09-17',to:'2026-09-17'})
  expect(archivePreview(selected).records).toBe(1);expect(selected.sessions.length).toBe(2);expect(selected.media.length).toBe(2)
  expect(selectArchiveRange(archive,id,{from:'2026-09-18',to:''}).sessions).toEqual([])
  expect(()=>selectArchiveRange(archive,id,{from:'2026-09-18',to:'2026-09-17'})).toThrow('日期')
})
it('exports an inert readable document without optional private fields by default',async()=>{
  const archive=archiveFixture(),html=await readableArchiveHtml(archive,{nickname:false,notes:false,photos:false})
  expect(html).not.toContain('测试私密昵称');expect(html).not.toContain('私密备注');expect(html).not.toContain('data:image/');expect(html).toContain('共1次记录');expect(html).toContain('V2')
  expect(html).toContain("default-src 'none'")
  const full=await readableArchiveHtml(archive,{nickname:true,notes:true,photos:true})
  expect(full).toContain('测试私密昵称');expect(full).toContain('&lt;script&gt;私密备注&lt;/script&gt;');expect(full).not.toContain('<script>');expect(full).toContain('data:image/png;base64,')
})
it('keeps experimental and uncalibrated readings clearly marked in the exported copy',async()=>{
  const archive=archiveFixture(),latest=archive.sessions[1];latest.kind='measurement';latest.report.front=[{label:'工程角度',value:'12°',view:'front',available:true,origin:'experimental',errors:[],score:0,note:'',group:'比例'}]
  const html=await readableArchiveHtml(archive,{nickname:false,notes:false,photos:false})
  expect(html).toContain('实验读数；误差范围未校准');expect(html).toContain('12°')
})
