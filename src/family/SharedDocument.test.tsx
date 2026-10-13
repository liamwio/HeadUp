import {it,expect,vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {SharedDocument} from './SharedDocument'
import type {ShareContent} from './shareContract'
it('renders only one record, two photo resources and one event page while keeping all record choices reachable',()=>{
  const content:ShareContent={schema:'HEADUP-SHARED-CONTENT-1',range:{from:'',to:''},boundary:'工程范围',sessions:Array.from({length:100},(_,i)=>({ref:'R'+(i+1),date:'2026-09-20',kind:'memory',note:'record-note-'+i+'-end',readings:[],photos:['front-original','front-analysis','profile-original','profile-analysis','top-original','top-analysis'].map(suffix=>({ref:'R'+(i+1)+'-'+suffix,view:suffix.split('-')[0],label:suffix}))})),events:Array.from({length:11},(_,i)=>({ref:'E'+i,date:'2026-09-20',type:'memory',text:'event-note-'+i+'-end'}))}
  const load=vi.fn(async()=>new Blob()),html=renderToStaticMarkup(<SharedDocument content={content} loadPhoto={load} onFailure={()=>{}}/>)
  expect(html.match(/<option /g)).toHaveLength(100);expect(html.match(/正在读取所选照片/g)).toHaveLength(2);expect(html).toContain('record-note-0-end');expect(html).not.toContain('record-note-1-end');expect(html).toContain('event-note-9-end');expect(html).not.toContain('event-note-10-end');expect(html).toContain('不仅是当前页');expect(load).not.toHaveBeenCalled()
})
