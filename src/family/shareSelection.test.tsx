import {it,expect} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {ShareSelection} from './ShareSelection'
import {toggleShareSelection} from './shareChoiceState'
const items=Array.from({length:10001},(_,i)=>({id:'row-'+i,label:'记录日期与说明-'+i+'-end'}))
it('mounts only 20 choices for a large archive and exposes total and cross-page selection counts',()=>{
  const selected=['row-0','row-21','row-10000'],html=renderToStaticMarkup(<ShareSelection title="照片记录" items={items} selected={selected} onToggle={()=>{}} onClear={()=>{}}/>)
  expect(html.match(/type="checkbox"/g)).toHaveLength(21)
  expect(html).toContain('共10001条');expect(html).toContain('已选3/100条');expect(html).toContain('第1/501页');expect(html).toContain('记录日期与说明-19-end');expect(html).not.toContain('记录日期与说明-20-end');expect(html).toContain('只看已选照片记录')
})
it('retains selections across pages, deduplicates, removes stale IDs and rejects unknown choices',()=>{
  let ids=toggleShareSelection([],items[0].id,true,items)
  ids=toggleShareSelection(ids,items[10000].id,true,items)
  expect(toggleShareSelection(ids,items[0].id,true,items)).toEqual(ids)
  expect(toggleShareSelection(ids,items[0].id,false,items)).toEqual([items[10000].id])
  expect(toggleShareSelection(['stale',...ids],items[21].id,true,items.slice(1))).toEqual([items[10000].id,items[21].id])
  expect(toggleShareSelection(ids,'not-here',true,items)).toEqual(ids)
})
it('enforces the 100-item limit during rapid updates and permits deselection at the limit',()=>{
  let ids:string[]=[]
  for(const row of items.slice(0,101))ids=toggleShareSelection(ids,row.id,true,items)
  expect(ids).toHaveLength(100);expect(ids).not.toContain('row-100')
  ids=toggleShareSelection(ids,'row-0',false,items)
  expect(toggleShareSelection(ids,'row-100',true,items)).toHaveLength(100)
})
it('renders an explicit empty range without stale checkboxes or pagination',()=>{
  const html=renderToStaticMarkup(<ShareSelection title="家庭事件" items={[]} selected={[]} onToggle={()=>{}} onClear={()=>{}}/>)
  expect(html).toContain('此日期范围没有可选资料');expect(html).not.toContain('<nav');expect(html).toContain('已选0/100条')
})
