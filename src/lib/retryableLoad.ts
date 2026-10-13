/** Share a pending/successful model load, but never cache a rejected load forever. */
export function retryableLoad<T>(load:()=>Promise<T>):()=>Promise<T> {
  let task:Promise<T>|undefined
  return ()=>task??=Promise.resolve().then(load).catch(error=>{task=undefined;throw error})
}
