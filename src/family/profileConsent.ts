export type ProfileConsent={version:'LOCAL-FAMILY-1'|'LOCAL-USER-1';guardianConfirmed?:true;childInformed?:true;storage:true;at:string}
export function validProfileConsent(value:any):value is ProfileConsent{
  if(!value||value.storage!==true||typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at)))return false
  if(value.version==='LOCAL-USER-1')return value.guardianConfirmed===undefined&&value.childInformed===undefined
  return value.version==='LOCAL-FAMILY-1'&&value.guardianConfirmed===true&&value.childInformed===true
}
