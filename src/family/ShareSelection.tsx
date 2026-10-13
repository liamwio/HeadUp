import {useId,useRef,useState} from 'react'
import {sharePage} from './sharePages'
import {SHARE_SELECTION_LIMIT,SHARE_SELECTION_PAGE_SIZE,type ShareChoice} from './shareChoiceState'
export function ShareSelection({title,items,selected,disabled=false,onToggle,onClear}:{
  title:string;items:ShareChoice[];selected:readonly string[];disabled?:boolean;
  onToggle:(id:string,checked:boolean)=>void;onClear:()=>void
}){
  const [index,setIndex]=useState(0),[onlySelected,setOnlySelected]=useState(false),selectedIds=new Set(selected),visible=onlySelected?items.filter(row=>selectedIds.has(row.id)):items,page=sharePage(visible,index,SHARE_SELECTION_PAGE_SIZE),hintId=useId(),pageRef=useRef<HTMLParagraphElement>(null)
  const go=(next:number)=>{setIndex(next);pageRef.current?.focus()}
  return <section className="family-share-selection" aria-label={'选择'+title}>
    <h2>{title}</h2><p id={hintId}>已选{selected.length}/{SHARE_SELECTION_LIMIT}条，跨页保留选择；当前日期范围共{items.length}条。改变日期会清空选择。</p>
    <div className="family-actions"><label className="family-inline-check"><input type="checkbox" checked={onlySelected} onChange={e=>{setOnlySelected(e.target.checked);setIndex(0)}}/>只看已选{title}</label><button type="button" disabled={disabled||!selected.length} onClick={onClear}>清空所选{title}</button></div>
    {disabled&&<p>请先勾选要分享的照片、读数或文字字段，再选择记录。</p>}
    <p ref={pageRef} tabIndex={-1} aria-live="polite" className="family-selection-page-status">{page.total?`显示第${page.start+1}–${page.end}条，共${page.total}条；第${page.index+1}/${page.count}页。`:onlySelected?'尚未选择此类资料。':'此日期范围没有可选资料。'}</p>
    <div className="family-selection-rows" aria-describedby={hintId}>{page.items.map(row=><label key={row.id} className="family-inline-check"><input type="checkbox" disabled={disabled||!selectedIds.has(row.id)&&selected.length>=SHARE_SELECTION_LIMIT} checked={selectedIds.has(row.id)} onChange={e=>{if(onlySelected&&!e.target.checked)pageRef.current?.focus();onToggle(row.id,e.target.checked)}}/>{row.label}</label>)}</div>
    {page.count>1&&<nav className="family-actions" aria-label={title+'选择分页'}><button type="button" disabled={page.index===0} onClick={()=>go(0)}>首页</button><button type="button" disabled={page.index===0} onClick={()=>go(page.index-1)}>上一页</button><button type="button" disabled={page.index+1>=page.count} onClick={()=>go(page.index+1)}>下一页</button><button type="button" disabled={page.index+1>=page.count} onClick={()=>go(page.count-1)}>末页</button></nav>}
  </section>
}
