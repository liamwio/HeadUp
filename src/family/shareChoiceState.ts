export const SHARE_SELECTION_LIMIT=100
export const SHARE_SELECTION_PAGE_SIZE=20
export type ShareChoice={id:string;label:string}
export function toggleShareSelection(ids:readonly string[],id:string,checked:boolean,available:readonly {id:string}[]){
  const valid=new Set(available.map(row=>row.id)),next=[...new Set(ids)].filter(value=>valid.has(value))
  if(!checked)return next.filter(value=>value!==id)
  if(!valid.has(id)||next.includes(id)||next.length>=SHARE_SELECTION_LIMIT)return next
  return [...next,id]
}
