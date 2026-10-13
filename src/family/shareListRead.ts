/** A delayed refresh must not resurrect the pre-revocation list. Stale errors are ignored too. */
export function createShareListRead<T>() {
  let generation=0
  return {invalidate(){generation++},async run(read:()=>Promise<T>,apply:(value:T)=>void){const ticket=++generation;try{const result=await read();if(ticket!==generation)return false;apply(result);return true}catch(error){if(ticket===generation)throw error;return false}}}
}
