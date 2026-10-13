export const SHARED_PHOTOS_PER_PAGE=2
export const SHARED_EVENTS_PER_PAGE=10
export function sharePage<T>(items:readonly T[],requested:number,size:number){
  if(!Number.isInteger(size)||size<1)throw new Error('每页数量无效')
  const count=Math.ceil(items.length/size),index=Math.min(Math.max(0,Number.isInteger(requested)?requested:0),Math.max(0,count-1)),start=index*size
  return {index,count,start,end:Math.min(items.length,start+size),items:items.slice(start,start+size),total:items.length}
}
