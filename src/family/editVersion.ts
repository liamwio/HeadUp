import {canonicalJson} from './cloudContract'
import type {FamilySession,RecordPlan} from './model'
export const editConflict=()=>new Error('内容已被另一页面或设备更新。本次未覆盖，当前输入仍保留；请先复制输入，再重新打开此页面核对后保存。')
export function planEditVersion(plan:RecordPlan|null|undefined){if(!plan)return null;const{lastNotifiedWindow,lastFollowupWindow,lastNotifiedDate,notificationError,...fields}=plan;return canonicalJson(fields)}
export function metadataEditVersion(session:FamilySession){return canonicalJson({recordedOn:session.recordedOn,note:session.note,history:session.metadataHistory})}
