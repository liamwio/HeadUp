import {photoDirectoryAvailable} from './photoDirectory'
import {PhonePhotoDirectory} from './PhonePhotoDirectory'
import {FAMILY_SERVICES_ENABLED} from '../productMode'
import {isHeadUpAndroid} from '../lib/appPlatform'
import { useState } from 'react'
import { ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import {FamilyDataTools} from './FamilyDataTools'
import {DeleteWorkspaceData} from './DeleteWorkspaceData'
import { familyStore, storageMessage } from './store'
import { type FamilyProfile } from './model'

export function FamilySettings({onShare,profile,onCreate,onEdit,onProfile,onRefresh,onDeleted,onAccount,onSync,cloudFamilyName}:{onShare:()=>void;onProfile:()=>void;profile:FamilyProfile;onCreate:()=>void;onEdit:()=>void;onRefresh:()=>Promise<void>;onDeleted:()=>void;onAccount:()=>void;onSync?:()=>void;cloudFamilyName?:string}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[deleteText,setDeleteText]=useState(''),[deleteOpen,setDeleteOpen]=useState(false)
  return <section><div className="family-page-heading"><div><span className="family-eyebrow">档案与数据</span><h1>记录属于你</h1><p>{cloudFamilyName?`当前为${cloudFamilyName}的家庭工作区；本机缓存和同步状态可在家庭同步页查看。`:'当前为个人本机模式，照片和档案仅保存在本机。'}</p></div><ShieldCheck size={38}/></div>
    <div className="family-settings-section"><h2>{profile.nickname}的档案</h2><p>出生年份：{profile.birthYear??'未填写'}</p><div className="family-actions"><button onClick={onProfile}>查看档案与拍摄基线</button><button onClick={onEdit}>编辑档案</button><button onClick={onCreate}><UserPlus size={17}/>创建新档案</button></div></div>
    {FAMILY_SERVICES_ENABLED&&<section className="family-settings-section"><h2>限时只读分享</h2><p>选择已同步资料、接收账号和有效期；对方无需加入家庭。可查看对象并撤回在线分享。</p><button onClick={onShare}>管理限时分享</button></section>}
    <PhonePhotoDirectory key={profile.id} profile={profile}/><FamilyDataTools profile={profile} onRefresh={onRefresh}/>
    {FAMILY_SERVICES_ENABLED&&<div className="family-settings-section"><h2>使用范围与权限</h2>{cloudFamilyName&&onSync&&<button onClick={onSync}>查看家庭同步状态</button>}<p>{cloudFamilyName?'这些记录在当前账号的本机缓存中，已连接的档案会同步给明确授权的家庭成员。':(isHeadUpAndroid()?'本机档案无需登录，能打开此应用的人可以访问。家庭账号与成员授权单独管理，登录不会自动上传本机照片。':'本机档案无需登录，同一浏览器使用者可以访问。家庭账号与成员授权单独管理，登录不会自动上传本机照片。')}</p><p>{cloudFamilyName?'家庭同步与AI处理是不同授权，不会因同步照片而自动发送给AI。':'照片不自动上传，也不用于训练。AI处理、成员邀请和分享使用各自的授权，不与本机保存捆绑。'}</p><button onClick={onAccount}>管理家庭账号与授权</button></div>}
    {message&&<p className="family-notice" role="status">{message}</p>}
    <div className="family-settings-section family-danger-zone"><h2>删除当前档案</h2><p>删除{profile.nickname}的照片、结果、备注、计划和本机冲突副本，不影响其他档案。建议先下载备份。{photoDirectoryAvailable()&&'手机照片目录中的副本需在系统相册或文件管理器中另行删除。'}</p>{cloudFamilyName&&<p>已连接云端的档案需完成删除同步，才会清理同步基线与本机分享恢复信息。离线或暂停同步时仍待处理；请在家庭同步页查看结果。</p>}{!deleteOpen?<button disabled={busy} onClick={()=>setDeleteOpen(true)}><Trash2 size={17}/>删除档案…</button>:<form onSubmit={async e=>{e.preventDefault();if(deleteText!==profile.nickname)return;setBusy(true);try{await familyStore.deleteProfile(profile.id);onDeleted()}catch(err){setMessage(storageMessage(err));setBusy(false)}}}><label>输入昵称“{profile.nickname}”确认删除<input value={deleteText} onChange={e=>setDeleteText(e.target.value)} autoComplete="off"/></label><div className="family-actions"><button disabled={busy||deleteText!==profile.nickname}>确认删除此档案</button><button type="button" disabled={busy} onClick={()=>{setDeleteOpen(false);setDeleteText('')}}>取消</button></div></form>}</div>
    <DeleteWorkspaceData onDeleted={onDeleted}/>
  </section>
}
