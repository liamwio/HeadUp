/** The UI accepts one inference job at a time. A cancelled/unmounted job cannot
 * commit a stale result or unlock a later job. */
export function createUploadGate(){
  let serial=0,active:number|null=null
  return {
    begin(){if(active!==null)return null;active=++serial;return active},
    isCurrent(token:number){return active===token},
    finish(token:number){if(active!==token)return false;active=null;return true},
    cancel(){active=null;serial++},
  }
}
