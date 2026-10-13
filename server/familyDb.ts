import {buildShareContent,validateShareScope,SHARE_PROTOCOL,type ShareContent,type ShareAsset,type ShareScope} from '../src/family/shareContract.ts'
import {completedPlan} from '../src/family/planCompletion.ts'
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto'
import {canonicalJson,cloudId,cloudMediaKey,validateCloudSnapshot,CLOUD_CONSENT_VERSION,type CloudRole,type CloudSnapshot} from '../src/family/cloudContract.ts'

export class FamilyError extends Error {status:number;code:string;details?:unknown;constructor(status:number,code:string,message:string,details?:unknown){super(message);this.status=status;this.code=code;this.details=details}}
const deny=()=>{throw new FamilyError(403,'forbidden','没有这个家庭或档案的访问权限')}
const digest=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
const secret=()=>randomBytes(32).toString('base64url')
const username=(v:unknown)=>{if(typeof v!=='string'||!/^[a-zA-Z0-9_.-]{3,64}$/.test(v))throw new FamilyError(400,'username_invalid','登录名使用3–64位字母、数字、点、横线或下划线');return v.toLowerCase()}
const password=(v:unknown)=>{if(typeof v!=='string'||v.length<12||v.length>128)throw new FamilyError(400,'password_invalid','密码需要12–128个字符');return v}
const hashPassword=(value:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(value,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,key)=>e?reject(e):resolve(key)))
const validText=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new FamilyError(400,'invalid_input','请检查填写内容');return v.trim()}
export type Identity={id:string;username:string;displayName:string}
type Member={role:CloudRole;scopes:string[]}

export class FamilyDatabase {
  readonly db:DatabaseSync
  private now:()=>number
  constructor(path:string,now:()=>number=Date.now){
    this.now=now;if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700})
    this.db=new DatabaseSync(path,{enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false,defensive:true})
    const version=Number(this.db.prepare('PRAGMA user_version').get()?.user_version??0)
    if(version>5){this.db.close();throw new Error('家庭数据库来自更新版本，请升级服务后再打开')}
    if(version>=1)for(const table of ['users','auth_sessions','families','members','profiles','assets','authors','invites','sync_receipts',...(version>=2?['entity_tombstones']:[]),...(version>=3?['handoffs']:[]),...(version>=4?['shares']:[]),...(version>=5?['family_delete_receipts']:[])])if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)){this.db.close();throw new Error('家庭数据库结构不完整，请从服务器备份恢复，不会自动创建空档案覆盖')}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf_hash TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS members(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,scopes TEXT NOT NULL,PRIMARY KEY(family_id,user_id)) STRICT;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id),version INTEGER NOT NULL,snapshot TEXT,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS assets(profile_id TEXT NOT NULL REFERENCES profiles(id),key TEXT NOT NULL,sha TEXT NOT NULL,mime TEXT NOT NULL,data BLOB NOT NULL,committed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,PRIMARY KEY(profile_id,key)) STRICT;
      CREATE TABLE IF NOT EXISTS authors(profile_id TEXT NOT NULL REFERENCES profiles(id),kind TEXT NOT NULL,entity_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(profile_id,kind,entity_id)) STRICT;
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,family_id TEXT NOT NULL REFERENCES families(id),recipient TEXT NOT NULL,role TEXT NOT NULL,scopes TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS sync_receipts(profile_id TEXT NOT NULL,mutation_id TEXT NOT NULL,user_id TEXT NOT NULL,body_hash TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(profile_id,mutation_id)) STRICT;
      CREATE TABLE IF NOT EXISTS entity_tombstones(profile_id TEXT NOT NULL REFERENCES profiles(id),kind TEXT NOT NULL,entity_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(profile_id,kind,entity_id)) STRICT;
      CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,profile_id TEXT NOT NULL REFERENCES profiles(id),creator_id TEXT NOT NULL REFERENCES users(id),side TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,claimant_id TEXT REFERENCES users(id),claim_hash TEXT,initial_roots TEXT NOT NULL,completed_session_id TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,profile_id TEXT NOT NULL REFERENCES profiles(id),creator_id TEXT NOT NULL REFERENCES users(id),recipient_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,scope_json TEXT NOT NULL,content_json TEXT,assets_json TEXT NOT NULL,request_hash TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS shares_profile_created ON shares(profile_id,created_at);
      CREATE INDEX IF NOT EXISTS shares_creator_expiry ON shares(creator_id,expires_at);
      CREATE TABLE IF NOT EXISTS family_delete_receipts(family_id TEXT NOT NULL REFERENCES families(id),mutation_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),scope_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(family_id,mutation_id)) STRICT;
      PRAGMA user_version=5;`)
  }
  private one(sql:string,...args:any[]):any{return this.db.prepare(sql).get(...args)}
  private all(sql:string,...args:any[]):any[]{return this.db.prepare(sql).all(...args)}
  private run(sql:string,...args:any[]){return this.db.prepare(sql).run(...args)}
  private atomic<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
  close(){this.db.close()}
  async register(name:unknown,pass:unknown,displayName:unknown){
    const login=username(name),value=password(pass),display=validText(displayName,40),salt=randomBytes(16).toString('hex'),hashed=(await hashPassword(value,salt)).toString('hex'),recovery=secret(),id=randomUUID()
    try{this.run('INSERT INTO users VALUES(?,?,?,?,?,?,?)',id,login,display,salt,hashed,digest(recovery),this.now())}catch(e){if(this.one('SELECT id FROM users WHERE username=?',login))throw new FamilyError(409,'username_taken','这个登录名已被使用');throw e}
    return {user:{id,username:login,displayName:display},recoveryCode:recovery}
  }
  async login(name:unknown,pass:unknown){
    const login=typeof name==='string'?name.toLowerCase():'',row=this.one('SELECT * FROM users WHERE username=?',login),candidate=typeof pass==='string'&&pass.length<=128?pass:''
    const calculated=await hashPassword(candidate,row?.salt??'00000000000000000000000000000000'),expected=row?Buffer.from(row.password_hash,'hex'):Buffer.alloc(64)
    if(!row||!timingSafeEqual(calculated,expected))throw new FamilyError(401,'login_failed','登录名或密码不正确')
    const token=secret(),csrf=this.csrfFor(token);this.run('INSERT INTO auth_sessions VALUES(?,?,?,?)',digest(token),row.id,digest(csrf),this.now()+30*86400_000)
    return {token,csrf,user:{id:row.id,username:row.username,displayName:row.display_name} as Identity}
  }
  authenticate(token:string|undefined):Identity|null{if(!token||token.length>100)return null;const row=this.one('SELECT u.id,u.username,u.display_name FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',digest(token),this.now());return row?{id:row.id,username:row.username,displayName:row.display_name}:null}
  verifyCsrf(token:string,csrf:string){if(!csrf||csrf.length>100)return false;const row=this.one('SELECT csrf_hash FROM auth_sessions WHERE token_hash=? AND expires_at>?',digest(token),this.now());return Boolean(row&&timingSafeEqual(Buffer.from(row.csrf_hash,'hex'),Buffer.from(digest(csrf),'hex')))}
  csrfFor(token:string){return digest('HEADUP-CSRF-1:'+token)}
  logout(token:string){this.run('DELETE FROM auth_sessions WHERE token_hash=?',digest(token))}
  logoutProof(userId:string,proof:string){if(!cloudId(userId)||!/^[a-f0-9]{64}$/.test(proof))throw new FamilyError(400,'invalid_logout','会话注销凭据无效');this.run('DELETE FROM auth_sessions WHERE user_id=? AND csrf_hash=?',userId,digest(proof))}
  async recover(name:unknown,code:unknown,newPassword:unknown){
    const login=username(name),value=password(newPassword),row=this.one('SELECT * FROM users WHERE username=?',login)
    if(!row||typeof code!=='string'||code.length>100||!timingSafeEqual(Buffer.from(row.recovery_hash,'hex'),Buffer.from(digest(code),'hex')))throw new FamilyError(401,'recovery_failed','登录名或恢复码不正确')
    const salt=randomBytes(16).toString('hex'),hashed=(await hashPassword(value,salt)).toString('hex'),next=secret()
    this.atomic(()=>{const current=this.one('SELECT recovery_hash FROM users WHERE id=?',row.id);if(current?.recovery_hash!==row.recovery_hash)throw new FamilyError(409,'recovery_used','恢复码已使用');this.run('UPDATE users SET salt=?,password_hash=?,recovery_hash=? WHERE id=?',salt,hashed,digest(next),row.id);this.run('DELETE FROM auth_sessions WHERE user_id=?',row.id)})
    return {recoveryCode:next}
  }
  createFamily(user:Identity,name:unknown){const id=randomUUID(),label=validText(name,80);this.atomic(()=>{this.run('INSERT INTO families VALUES(?,?,?,?)',id,label,user.id,this.now());this.run('INSERT INTO members VALUES(?,?,?,?)',id,user.id,'owner','[]')});return{id,name:label,role:'owner' as const}}
  families(user:Identity){return this.all('SELECT f.id,f.name,m.role FROM members m JOIN families f ON f.id=m.family_id WHERE m.user_id=?',user.id)}
  membership(user:Identity,familyId:string):Member{const row=this.one('SELECT role,scopes FROM members WHERE family_id=? AND user_id=?',familyId,user.id);if(!row)deny();return{role:row.role,scopes:JSON.parse(row.scopes)}}
  private owner(user:Identity,familyId:string){if(this.membership(user,familyId).role!=='owner')deny()}
  private profileAccess(user:Identity,id:string,allowDeleted=false){const row=this.one('SELECT * FROM profiles WHERE id=?',id);if(!row)deny();const member=this.membership(user,row.family_id);if(member.role!=='owner'&&!member.scopes.includes(id))deny();if(row.deleted&&!allowDeleted)throw new FamilyError(410,'profile_deleted','这个同步档案已删除');return{row,member}}
  listProfiles(user:Identity,familyId:string){const member=this.membership(user,familyId);return this.all("SELECT id,version,deleted,updated_at,json_extract(snapshot,'$.profile.nickname') AS nickname FROM profiles WHERE family_id=?",familyId).filter(row=>member.role==='owner'||member.scopes.includes(row.id)).map(row=>({id:row.id,version:row.version,deleted:Boolean(row.deleted),updatedAt:row.updated_at,nickname:row.nickname??'',role:member.role}))}
  createProfile(user:Identity,familyId:string,profile:unknown,consent:unknown){
    this.owner(user,familyId);if(consent!==CLOUD_CONSENT_VERSION)throw new FamilyError(400,'consent_required','请先确认家庭同步授权')
    const id=(profile as any)?.id;if(!cloudId(id))throw new FamilyError(400,'profile_invalid','档案ID无效')
    let snapshot:CloudSnapshot;try{snapshot=validateCloudSnapshot({schema:'HEADUP-SYNC-1',profile,sessions:[],plans:[],events:[],media:[]},id)}catch{throw new FamilyError(400,'profile_invalid','档案内容无效')}
    try{this.run('INSERT INTO profiles VALUES(?,?,1,?,0,?)',id,familyId,JSON.stringify(snapshot),this.now())}catch{throw new FamilyError(409,'profile_exists','档案ID已存在，请使用邀请加入或为副本分配新的ID')}
    return{id,version:1}
  }
  getSnapshot(user:Identity,id:string){const{row}=this.profileAccess(user,id,true);return{id,familyId:row.family_id,version:row.version,deleted:Boolean(row.deleted),snapshot:row.snapshot?JSON.parse(row.snapshot) as CloudSnapshot:null,authors:this.all('SELECT kind,entity_id AS id,user_id AS userId FROM authors WHERE profile_id=?',id),deletedEntities:this.all('SELECT kind,entity_id AS id,deleted_at AS deletedAt FROM entity_tombstones WHERE profile_id=?',id)}}
  previewShare(user:Identity,profileId:string,expected:number,scope:unknown,recipientName?:unknown){
    const {row,member}=this.profileAccess(user,profileId);if(member.role==='child')deny()
    if(row.version!==expected)throw new FamilyError(409,'version_conflict','档案已更新，请先同步并重新核对分享范围')
    let recipient:any;if(recipientName!==undefined){recipient=this.one('SELECT username,display_name AS displayName FROM users WHERE username=?',username(recipientName));if(!recipient)throw new FamilyError(400,'share_recipient_missing','接收方需先注册此站点账号');if(recipient.username===user.username)throw new FamilyError(400,'share_recipient_invalid','请选择另一位接收方')}
    try{const prepared=buildShareContent(JSON.parse(row.snapshot),scope);return {recipient,scope:prepared.scope,content:prepared.content,photoCount:prepared.assets.length,version:row.version}}catch{throw new FamilyError(400,'share_scope_invalid','分享仅支持范围内已同步记录的最新版本，每类最多100条，请检查选择')}
  }
  private shareInfo(row:any){const recipient=this.one('SELECT username,display_name FROM users WHERE id=?',row.recipient_id),creator=this.one('SELECT display_name FROM users WHERE id=?',row.creator_id);return {id:row.id,profileId:row.profile_id,creatorId:row.creator_id,creatorName:creator?.display_name??'',recipient:{username:recipient?.username??'',displayName:recipient?.display_name??''},createdAt:row.created_at,expiresAt:row.expires_at,state:row.revoked_at!==null?'revoked':row.expires_at<=this.now()?'expired':'active',scope:JSON.parse(row.scope_json) as ShareScope}}
  private purgeShare(id:string){this.run("UPDATE shares SET revoked_at=COALESCE(revoked_at,?),content_json=NULL,assets_json='[]' WHERE id=?",this.now(),id)}
  createShare(user:Identity,profileId:string,expected:number,id:unknown,token:unknown,recipientName:unknown,ttlHours:unknown,rawScope:unknown,consent:unknown){return this.atomic(()=>{
    const {row,member}=this.profileAccess(user,profileId);if(member.role==='child')deny()
    if(consent!==SHARE_PROTOCOL||!cloudId(id)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||![1,24,168].includes(ttlHours as number))throw new FamilyError(400,'share_invalid','请确认分享对象、范围与有效期')
    const target=username(recipientName),recipient=this.one('SELECT id FROM users WHERE username=?',target);if(!recipient)throw new FamilyError(400,'share_recipient_missing','接收方需先注册此站点账号；分享不会将对方加入家庭')
    if(recipient.id===user.id)throw new FamilyError(400,'share_recipient_invalid','请选择另一位接收方的账号')
    let scope:ShareScope;try{scope=validateShareScope(rawScope)}catch{throw new FamilyError(400,'share_scope_invalid','请检查分享范围与内容选择')}
    const requestHash=digest(canonicalJson({profileId,expected,recipientId:recipient.id,ttlHours,scope})),old=this.one('SELECT * FROM shares WHERE id=?',id)
    if(old){if(old.creator_id!==user.id||old.token_hash!==digest(token)||old.request_hash!==requestHash)throw new FamilyError(409,'share_reused','分享编号已使用，请核对原分享状态');return this.shareInfo(old)}
    if(this.one('SELECT id FROM shares WHERE token_hash=?',digest(token)))throw new FamilyError(409,'share_reused','分享代码已使用，请创建新的分享')
    if(row.version!==expected)throw new FamilyError(409,'version_conflict','档案已更新，请重新同步并预览后创建分享')
    if(this.one('SELECT count(*) AS n FROM shares WHERE creator_id=? AND revoked_at IS NULL AND expires_at>?',user.id,this.now()).n>=20)throw new FamilyError(429,'share_limit','请先撤回或等待已有分享过期')
    let prepared:ReturnType<typeof buildShareContent>;try{prepared=buildShareContent(JSON.parse(row.snapshot),scope)}catch{throw new FamilyError(400,'share_scope_invalid','选择包含不在范围内、已删除或非最新版本的记录')}
    const now=this.now();this.run('INSERT INTO shares VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?)',id,digest(token),profileId,user.id,recipient.id,now,now+(ttlHours as number)*3600000,JSON.stringify(scope),JSON.stringify(prepared.content),JSON.stringify(prepared.assets),requestHash)
    return this.shareInfo(this.one('SELECT * FROM shares WHERE id=?',id))
  })}
  listShares(user:Identity,profileId:string){const {member}=this.profileAccess(user,profileId,true);if(member.role==='child')deny();return this.all('SELECT id,profile_id,creator_id,recipient_id,created_at,expires_at,revoked_at,scope_json FROM shares WHERE profile_id=?'+(member.role==='owner'?'':' AND creator_id=?')+' ORDER BY created_at DESC LIMIT 200',...member.role==='owner'?[profileId]:[profileId,user.id]).map(row=>this.shareInfo(row))}
  revokeShare(user:Identity,id:string){return this.atomic(()=>{const row=this.one('SELECT * FROM shares WHERE id=?',id);if(!row)deny();const {member}=this.profileAccess(user,row.profile_id,true);if(member.role==='child'||member.role!=='owner'&&row.creator_id!==user.id)deny();this.purgeShare(id);return this.shareInfo(this.one('SELECT * FROM shares WHERE id=?',id))})}
  private readableShare(user:Identity,token:unknown){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new FamilyError(404,'share_unavailable','分享不存在或不属于当前账号')
    const row=this.one('SELECT * FROM shares WHERE token_hash=? AND recipient_id=?',digest(token),user.id);if(!row)throw new FamilyError(404,'share_unavailable','分享不存在或不属于当前账号')
    if(row.revoked_at!==null||row.expires_at<=this.now()||!row.content_json)throw new FamilyError(410,'share_ended','分享已撤回或过期')
    try{const source=this.profileAccess({id:row.creator_id,username:'',displayName:''},row.profile_id);if(source.member.role==='child')throw new Error();const snapshot=JSON.parse(source.row.snapshot) as CloudSnapshot,scope=JSON.parse(row.scope_json) as ShareScope;if(scope.sessionIds.some(id=>!snapshot.sessions.some(s=>s.id===id))||scope.eventIds.some(id=>!snapshot.events.some(e=>e.id===id)))throw new Error()}catch{this.purgeShare(row.id);throw new FamilyError(410,'share_ended','原资料或分享权限已变化，此分享停止提供内容')}
    return row
  }
  readShare(user:Identity,token:unknown){const row=this.readableShare(user,token);return {id:row.id,createdAt:row.created_at,expiresAt:row.expires_at,serverNow:this.now(),content:JSON.parse(row.content_json) as ShareContent}}
  readSharedPhoto(user:Identity,token:unknown,ref:unknown){const row=this.readableShare(user,token),asset=(JSON.parse(row.assets_json) as ShareAsset[]).find(a=>a.ref===ref);if(!asset)throw new FamilyError(404,'share_photo_unavailable','此照片不在分享范围内');const photo=this.one('SELECT data,mime,sha FROM assets WHERE profile_id=? AND key=? AND committed=1',row.profile_id,asset.key);if(!photo||photo.sha!==asset.sha256){this.purgeShare(row.id);throw new FamilyError(410,'share_ended','原照片已变化，此分享停止提供内容')}return photo}
  private handoffInfo(user:Identity,task:any){
    const {row}=this.profileAccess(user,task.profile_id),snapshot=JSON.parse(row.snapshot),family=this.one('SELECT name FROM families WHERE id=?',row.family_id)
    return {id:task.id,profileId:task.profile_id,familyId:row.family_id,familyName:family.name,nickname:snapshot.profile.nickname,side:task.side,expiresAt:task.expires_at,state:task.state==='completed'||task.state==='revoked'?task.state:task.expires_at<=this.now()?'expired':task.state,claimedByMe:task.claimant_id===user.id,sessionId:task.completed_session_id??null}
  }
  createHandoff(user:Identity,profileId:string,expected:number,id:unknown,token:unknown,side:unknown){return this.atomic(()=>{
    const {row}=this.profileAccess(user,profileId)
    if(!cloudId(id)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!['left_profile','right_profile',null].includes(side as any))throw new FamilyError(400,'handoff_invalid','接力任务格式无效')
    const old=this.one('SELECT * FROM handoffs WHERE id=?',id)
    if(old){if(old.creator_id!==user.id||old.profile_id!==profileId||old.token_hash!==digest(token)||old.side!==side)throw new FamilyError(409,'handoff_reused','任务编号已使用');return this.handoffInfo(user,old)}
    if(this.one('SELECT id FROM handoffs WHERE token_hash=?',digest(token)))throw new FamilyError(409,'handoff_reused','接力代码已使用，请创建新的任务')
    if(row.version!==expected)throw new FamilyError(409,'version_conflict','档案已更新，请先同步再创建接力')
    if(this.one("SELECT count(*) AS n FROM handoffs WHERE creator_id=? AND state IN ('pending','claimed') AND expires_at>?",user.id,this.now()).n>=3)throw new FamilyError(429,'handoff_limit','请先结束或撤回已有接力任务')
    const snapshot=JSON.parse(row.snapshot),roots=[...new Set(snapshot.sessions.map((s:any)=>s.revision?.rootId??s.id))]
    this.run('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,NULL)',id,digest(token),profileId,user.id,side,this.now(),this.now()+10*60_000,'pending',JSON.stringify(roots))
    return this.handoffInfo(user,this.one('SELECT * FROM handoffs WHERE id=?',id))
  })}
  inspectHandoff(user:Identity,token:unknown){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new FamilyError(404,'handoff_unavailable','接力不存在或已失效');const row=this.one('SELECT * FROM handoffs WHERE token_hash=?',digest(token));if(!row)throw new FamilyError(404,'handoff_unavailable','接力不存在或已失效');return this.handoffInfo(user,row)}
  handoffStatus(user:Identity,id:string){const task=this.one('SELECT * FROM handoffs WHERE id=? AND creator_id=?',id,user.id);if(!task)deny();return this.handoffInfo(user,task)}
  claimHandoff(user:Identity,token:unknown,claimId:unknown){return this.atomic(()=>{
    const info=this.inspectHandoff(user,token);if(typeof claimId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(claimId))throw new FamilyError(400,'handoff_invalid','设备接力编号无效')
    const row=this.one('SELECT * FROM handoffs WHERE id=?',info.id)
    if(['expired','revoked','completed'].includes(info.state))throw new FamilyError(410,'handoff_unavailable','接力已结束或过期，请返回原记录或重新创建')
    if(row.state==='claimed'){if(row.claimant_id!==user.id||row.claim_hash!==digest(claimId))throw new FamilyError(409,'handoff_claimed','已有另一台设备领取接力');return info}
    this.run("UPDATE handoffs SET state='claimed',claimant_id=?,claim_hash=?,expires_at=? WHERE id=?",user.id,digest(claimId),this.now()+30*60_000,info.id)
    return this.handoffInfo(user,this.one('SELECT * FROM handoffs WHERE id=?',info.id))
  })}
  revokeHandoff(user:Identity,id:string){return this.atomic(()=>{const info=this.handoffStatus(user,id);if(info.state==='completed')throw new FamilyError(409,'handoff_completed','记录已保存，撤回接力不会删除照片');this.run("UPDATE handoffs SET state='revoked' WHERE id=?",id);return this.handoffStatus(user,id)})}
  completeHandoff(user:Identity,id:string,claimId:unknown,sessionId:unknown){return this.atomic(()=>{
    const row=this.one('SELECT * FROM handoffs WHERE id=?',id);if(!row)throw new FamilyError(404,'handoff_unavailable','接力不存在或已失效')
    const info=this.handoffInfo(user,row)
    if(typeof claimId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(claimId)||row.claimant_id!==user.id||row.claim_hash!==digest(claimId))deny()
    if(info.state==='completed'){if(row.completed_session_id!==sessionId)throw new FamilyError(409,'handoff_completed','接力已有完成记录');return info}
    if(info.state!=='claimed')throw new FamilyError(410,'handoff_unavailable','接力已结束或过期；已保存的照片不受影响')
    if(!cloudId(sessionId))throw new FamilyError(400,'handoff_invalid','记录编号无效')
    const snapshot=this.getSnapshot(user,row.profile_id).snapshot!,session=snapshot.sessions.find(s=>s.id===sessionId),root=session?.revision?.rootId??session?.id
    if(!session)throw new FamilyError(409,'handoff_waiting_sync','记录尚未同步完成，请联网后重试')
    if(JSON.parse(row.initial_roots).includes(root)||this.one('SELECT user_id FROM authors WHERE profile_id=? AND kind=? AND entity_id=?',row.profile_id,'session',root)?.user_id!==user.id)throw new FamilyError(409,'handoff_record_mismatch','需要这次接力中新保存的记录，未关联旧照片')
    if(!['front','profile'].every(view=>session.captures.some((c:any)=>c.id===view))||row.side&&!session.captures.some((c:any)=>c.id==='profile'&&c.poseValidation?.estimatedPose===row.side))throw new FamilyError(409,'handoff_views_incomplete','已保存记录仍缺指定视角，可补齐后再次完成接力')
    this.run("UPDATE handoffs SET state='completed',completed_session_id=? WHERE id=?",sessionId,id)
    return this.handoffInfo(user,this.one('SELECT * FROM handoffs WHERE id=?',id))
  })}
  receipt(user:Identity,id:string,mutationId:string){this.profileAccess(user,id,true);const row=this.one('SELECT * FROM sync_receipts WHERE profile_id=? AND mutation_id=? AND user_id=?',id,mutationId,user.id);return row?{version:row.version,hash:row.body_hash,cancelled:row.body_hash==='cancelled'}:null}
  cancelMutation(user:Identity,id:string,mutationId:string){return this.atomic(()=>{this.profileAccess(user,id,true);const old=this.one('SELECT * FROM sync_receipts WHERE profile_id=? AND mutation_id=?',id,mutationId);if(old){if(old.user_id!==user.id)deny();return{version:old.version,hash:old.body_hash,cancelled:old.body_hash==='cancelled'}}this.run('INSERT INTO sync_receipts VALUES(?,?,?,?,?)',id,mutationId,user.id,'cancelled',0);return{version:0,hash:'cancelled',cancelled:true}})}
  putAsset(user:Identity,id:string,key:string,mime:string,data:Uint8Array,expectedVersion?:number){
    const{row}=this.profileAccess(user,id);if(expectedVersion!==undefined&&row.version!==expectedVersion)throw new FamilyError(409,'version_conflict','档案已更新，未接受过期照片上传',{version:row.version})
    if(!cloudMediaKey(key)||!['image/png','image/jpeg','image/webp','image/avif'].includes(mime)||!data.byteLength||data.byteLength>30*1024*1024)throw new FamilyError(400,'media_invalid','照片编号、格式或大小不正确')
    if(this.one('SELECT entity_id FROM entity_tombstones WHERE profile_id=? AND kind=? AND entity_id=?',id,'session',key.split('/')[0]))throw new FamilyError(409,'entity_deleted','该记录已删除，不再接受它的照片')
    const hash=digest(data),old=this.one('SELECT sha,mime FROM assets WHERE profile_id=? AND key=?',id,key)
    if(old){if(old.sha!==hash||old.mime!==mime)throw new FamilyError(409,'media_immutable','已有照片不可覆盖，请创建新的版本');this.run('UPDATE assets SET created_at=? WHERE profile_id=? AND key=? AND committed=0',this.now(),id,key);return{key,sha256:hash,type:mime,size:data.byteLength}}
    const bytes=this.one('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM assets WHERE profile_id=?',id).bytes
    if(bytes+data.byteLength>2*1024*1024*1024)throw new FamilyError(413,'storage_limit','该同步档案已达到2GB上限，本机记录仍保留')
    this.run('INSERT INTO assets VALUES(?,?,?,?,?,0,?)',id,key,hash,mime,data,this.now());return{key,sha256:hash,type:mime,size:data.byteLength}
  }
  getAsset(user:Identity,id:string,key:string){this.profileAccess(user,id);const row=this.one('SELECT data,mime,sha FROM assets WHERE profile_id=? AND key=? AND committed=1',id,key);if(!row)throw new FamilyError(404,'media_missing','照片暂不可用');return row}
  commit(user:Identity,id:string,expected:number,mutationId:string,raw:unknown){
    let snapshot:CloudSnapshot;try{snapshot=validateCloudSnapshot(raw,id)}catch{throw new FamilyError(400,'snapshot_invalid','同步数据无效，原档案未改变')}
    const json=canonicalJson(snapshot),hash=digest(json)
    return this.atomic(()=>{
      const{row,member}=this.profileAccess(user,id),receipt=this.one('SELECT * FROM sync_receipts WHERE profile_id=? AND mutation_id=?',id,mutationId)
      if(receipt){if(receipt.user_id!==user.id||receipt.body_hash!==hash)throw new FamilyError(409,'mutation_reused','请求编号已被使用');return{version:receipt.version,replayed:true}}
      if(row.version!==expected)throw new FamilyError(409,'version_conflict','另一设备已更新此档案，请先处理冲突',{version:row.version})
      const old=JSON.parse(row.snapshot) as CloudSnapshot,oldSessions=new Map(old.sessions.map(s=>[s.id,s])),newSessions=new Map(snapshot.sessions.map(s=>[s.id,s]))
      for(const [kind,items]of [['session',snapshot.sessions],['event',snapshot.events]] as const)for(const item of items)if(this.one('SELECT entity_id FROM entity_tombstones WHERE profile_id=? AND kind=? AND entity_id=?',id,kind,item.id))throw new FamilyError(409,'entity_deleted','该记录已在另一设备删除，不能用旧副本恢复；需要恢复时请明确创建备份副本')
      const incomingEvents=new Map(snapshot.events.map(e=>[e.id,e]));for(const prior of old.events){const next=incomingEvents.get(prior.id);if(next&&prior.detailsVersion==='HEADUP-EVENT-1'&&next.detailsVersion!=='HEADUP-EVENT-1')throw new FamilyError(409,'event_metadata_version','事件含新版来源和讨论信息，请更新客户端后同步；原事件未改变')}
      for(const previous of old.sessions)if(!newSessions.has(previous.id)&&snapshot.sessions.some(s=>(s.revision?.rootId??s.id)===(previous.revision?.rootId??previous.id)))throw new FamilyError(409,'history_immutable','不能从同步记录中省略旧版本；删除记录需包含该次全部修订')
      for(const s of snapshot.sessions){const prior=oldSessions.get(s.id);if(prior&&['captures','report','version','revision','kind','protocol','createdAt'].some(k=>canonicalJson(prior[k]??null)!==canonicalJson(s[k]??null)))throw new FamilyError(409,'history_immutable','历史分析不能覆盖，请保存新的修订版本')}
      if(member.role==='child'){
        const limited=(p:any)=>{const{preferredSide,updatedAt,...rest}=p;return rest};if(canonicalJson(limited(old.profile))!==canonicalJson(limited(snapshot.profile)))deny()
        for(const s of old.sessions){const next=newSessions.get(s.id);if(!next||canonicalJson(next)!==canonicalJson(s)){const root=s.revision?.rootId??s.id,author=this.one('SELECT user_id FROM authors WHERE profile_id=? AND kind=? AND entity_id=?',id,'session',root);if(author?.user_id!==user.id)deny()}}
        const newEvents=new Map(snapshot.events.map(e=>[e.id,e]));for(const e of old.events)if(canonicalJson(newEvents.get(e.id)??null)!==canonicalJson(e)){const author=this.one('SELECT user_id FROM authors WHERE profile_id=? AND kind=? AND entity_id=?',id,'event',e.id);if(author?.user_id!==user.id)deny()}
        const before=old.plans[0],after=snapshot.plans[0]
        if(canonicalJson(before??null)!==canonicalJson(after??null)){
          if(!before||!after)deny()
          let derived=before
          for(const candidate of snapshot.sessions.filter(s=>!oldSessions.has(s.id)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)))derived=completedPlan(derived as any,candidate as any,candidate.recordedOn)
          const pausedBeforeRecording=after.enabled===false&&canonicalJson({...before,enabled:false})===canonicalJson(after)
          if(!pausedBeforeRecording&&canonicalJson(derived)!==canonicalJson(after)&&!(after.enabled===false&&canonicalJson({...derived,enabled:false})===canonicalJson(after)))deny()
        }
      }
      const used=new Set<string>();for(const media of snapshot.media)for(const ref of [media.processed,media.original].filter(Boolean)){const r=ref!,asset=this.one('SELECT sha,mime,length(data) AS size FROM assets WHERE profile_id=? AND key=?',id,r.key);if(!asset||asset.sha!==r.sha256||asset.mime!==r.type||asset.size!==r.size)throw new FamilyError(409,'media_incomplete','照片尚未完整上传，原档案未改变');used.add(r.key)}
      for(const [kind,before,after]of [['session',old.sessions,snapshot.sessions],['event',old.events,snapshot.events]] as const){const remaining=new Set(after.map(item=>item.id));for(const item of before)if(!remaining.has(item.id)){this.run('INSERT OR IGNORE INTO entity_tombstones VALUES(?,?,?,?)',id,kind,item.id,this.now());this.run('DELETE FROM authors WHERE profile_id=? AND kind=? AND entity_id=?',id,kind,item.id)}}
      for(const share of this.all('SELECT id,scope_json FROM shares WHERE profile_id=? AND revoked_at IS NULL',id)){const scope=JSON.parse(share.scope_json) as ShareScope;if(scope.sessionIds.some(key=>!newSessions.has(key))||scope.eventIds.some(key=>!incomingEvents.has(key)))this.purgeShare(share.id)}
      for(const asset of this.all('SELECT key,committed FROM assets WHERE profile_id=?',id)){if(used.has(asset.key))this.run('UPDATE assets SET committed=1 WHERE profile_id=? AND key=?',id,asset.key);else if(asset.committed)this.run('DELETE FROM assets WHERE profile_id=? AND key=?',id,asset.key)}
      for(const [kind,rows] of [['session',snapshot.sessions],['event',snapshot.events]] as const)for(const item of rows)this.run('INSERT OR IGNORE INTO authors VALUES(?,?,?,?)',id,kind,item.id,user.id)
      const version=row.version+1;this.run('UPDATE profiles SET snapshot=?,version=?,updated_at=? WHERE id=?',json,version,this.now(),id);this.run('INSERT INTO sync_receipts VALUES(?,?,?,?,?)',id,mutationId,user.id,hash,version)
      return{version,replayed:false}
    })
  }
  private deleteProfileContents(id:string){
    this.run("UPDATE shares SET revoked_at=COALESCE(revoked_at,?),content_json=NULL,assets_json='[]' WHERE profile_id=?",this.now(),id)
    this.run("UPDATE handoffs SET state='revoked',claim_hash=NULL,claimant_id=NULL,initial_roots='[]',completed_session_id=NULL WHERE profile_id=?",id)
    this.run("UPDATE invites SET revoked=1 WHERE used=0 AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value=?)",id)
    for(const table of ['assets','authors','sync_receipts','entity_tombstones'])this.run('DELETE FROM '+table+' WHERE profile_id=?',id)
    this.run('UPDATE profiles SET snapshot=NULL,deleted=1,version=version+1,updated_at=? WHERE id=?',this.now(),id)
  }
  deleteProfile(user:Identity,id:string,expected:number){return this.atomic(()=>{const{row,member}=this.profileAccess(user,id);if(member.role==='child')deny();if(row.version!==expected)throw new FamilyError(409,'version_conflict','另一设备已修改档案，请刷新后再删除',{version:row.version});this.deleteProfileContents(id);return{version:row.version+1,deleted:true}})}
  familyDeletionPreview(user:Identity,familyId:string){
    this.owner(user,familyId)
    const family=this.one('SELECT id,name FROM families WHERE id=?',familyId),rows=this.all('SELECT id,version,snapshot FROM profiles WHERE family_id=? AND deleted=0 ORDER BY id',familyId),assets=this.all('SELECT a.profile_id,a.key,a.sha FROM assets a JOIN profiles p ON p.id=a.profile_id WHERE p.family_id=? AND p.deleted=0 ORDER BY a.profile_id,a.key',familyId)
    const profiles=rows.map(row=>{const snapshot=JSON.parse(row.snapshot) as CloudSnapshot;return{id:row.id,version:row.version,nickname:snapshot.profile.nickname as string,records:new Set(snapshot.sessions.map(s=>s.revision?.rootId??s.id)).size,photos:assets.filter(a=>a.profile_id===row.id).length}})
    return {protocol:'HEADUP-FAMILY-DELETE-1' as const,family,scopeHash:digest(canonicalJson({family,profiles:rows.map(({id,version})=>({id,version})),assets})),profiles}
  }
  familyDeletionReceipt(user:Identity,familyId:string,mutationId:string){
    this.owner(user,familyId);const row=this.one('SELECT * FROM family_delete_receipts WHERE family_id=? AND mutation_id=?',familyId,mutationId)
    if(!row)return null;if(row.user_id!==user.id)deny();return JSON.parse(row.result_json)
  }
  deleteFamilyProfiles(user:Identity,familyId:string,mutationId:unknown,scopeHash:unknown,protocol:unknown){return this.atomic(()=>{
    this.owner(user,familyId)
    if(!cloudId(mutationId)||typeof scopeHash!=='string'||!/^[a-f0-9]{64}$/.test(scopeHash)||protocol!=='HEADUP-FAMILY-DELETE-1')throw new FamilyError(400,'deletion_invalid','请先预览并确认家庭云端删除范围')
    const old=this.one('SELECT * FROM family_delete_receipts WHERE family_id=? AND mutation_id=?',familyId,mutationId)
    if(old){if(old.user_id!==user.id)deny();if(old.scope_hash!==scopeHash)throw new FamilyError(409,'deletion_reused','删除编号已用于另一份范围，不能改换范围重试');return JSON.parse(old.result_json)}
    const preview=this.familyDeletionPreview(user,familyId)
    if(preview.scopeHash!==scopeHash)throw new FamilyError(409,'deletion_scope_changed','家庭档案或待上传照片已变化，本次未删除，请重新预览完整范围')
    if(!preview.profiles.length)throw new FamilyError(400,'deletion_empty','此家庭已经没有云端档案')
    for(const profile of preview.profiles)this.deleteProfileContents(profile.id)
    const result={protocol:'HEADUP-FAMILY-DELETE-1',id:mutationId,familyId,scopeHash,completedAt:this.now(),profiles:preview.profiles.map(p=>({id:p.id,version:p.version+1}))}
    this.run('INSERT INTO family_delete_receipts VALUES(?,?,?,?,?,?)',familyId,mutationId,user.id,scopeHash,JSON.stringify(result),result.completedAt)
    return result
  })}
  invite(user:Identity,familyId:string,recipient:unknown,role:unknown,scopes:unknown){
    this.owner(user,familyId);const target=username(recipient)
    if(!['guardian','child'].includes(String(role))||!Array.isArray(scopes)||!scopes.length||scopes.length>100||new Set(scopes).size!==scopes.length||scopes.some(id=>typeof id!=='string'||!this.one('SELECT id FROM profiles WHERE id=? AND family_id=? AND deleted=0',id,familyId)))throw new FamilyError(400,'invite_invalid','请明确邀请角色和可访问档案')
    const token=secret(),id=randomUUID(),expiresAt=this.now()+7*86400_000;this.run('INSERT INTO invites VALUES(?,?,?,?,?,?,?,0,0)',id,digest(token),familyId,target,role,JSON.stringify(scopes),expiresAt)
    return{id,token,expiresAt,recipient:target,role,profileIds:scopes}
  }
  inspectInvite(user:Identity,token:string){const invite=this.one('SELECT i.*,f.name FROM invites i JOIN families f ON f.id=i.family_id WHERE i.token_hash=?',digest(token));if(!invite||invite.used||invite.revoked||invite.expires_at<=this.now()||invite.recipient!==user.username)throw new FamilyError(404,'invite_unavailable','邀请不存在、已失效或不属于当前登录名');const profiles=JSON.parse(invite.scopes).map((id:string)=>this.one("SELECT id,json_extract(snapshot,'$.profile.nickname') AS nickname FROM profiles WHERE id=? AND deleted=0",id));if(profiles.some((p:any)=>!p))throw new FamilyError(410,'invite_unavailable','邀请中的档案已经删除');return{...invite,profiles}}
  canRegisterWithInvite(name:unknown,token:unknown){if(typeof name!=='string'||typeof token!=='string'||token.length>100)return false;const row=this.one('SELECT recipient,used,revoked,expires_at FROM invites WHERE token_hash=?',digest(token));return Boolean(row&&!row.used&&!row.revoked&&row.expires_at>this.now()&&row.recipient===name.toLowerCase())}
  acceptInvite(user:Identity,token:string,consent:unknown){if(consent!==CLOUD_CONSENT_VERSION)throw new FamilyError(400,'consent_required','请先确认加入家庭同步');return this.atomic(()=>{const invite=this.inspectInvite(user,token);if(this.one('SELECT role FROM members WHERE family_id=? AND user_id=?',invite.family_id,user.id))throw new FamilyError(409,'already_member','已经是该家庭成员；不能用邀请改变既有权限');const scopes=JSON.parse(invite.scopes);if(scopes.some((id:string)=>!this.one('SELECT id FROM profiles WHERE id=? AND deleted=0',id)))throw new FamilyError(410,'invite_unavailable','邀请中的档案已经删除');this.run('INSERT INTO members VALUES(?,?,?,?)',invite.family_id,user.id,invite.role,invite.scopes);this.run('UPDATE invites SET used=1 WHERE id=?',invite.id);return{familyId:invite.family_id,role:invite.role,profileIds:scopes}})}
  members(user:Identity,familyId:string){this.owner(user,familyId);return this.all('SELECT u.id,u.username,u.display_name,m.role,m.scopes FROM members m JOIN users u ON u.id=m.user_id WHERE m.family_id=?',familyId).map(m=>({id:m.id,username:m.username,displayName:m.display_name,role:m.role,profileIds:JSON.parse(m.scopes)}))}
  invites(user:Identity,familyId:string){this.owner(user,familyId);return this.all('SELECT id,recipient,role,scopes,expires_at,used,revoked FROM invites WHERE family_id=?',familyId).map(i=>({...i,scopes:JSON.parse(i.scopes)}))}
  revokeInvite(user:Identity,familyId:string,id:string){this.owner(user,familyId);this.run('UPDATE invites SET revoked=1 WHERE family_id=? AND id=?',familyId,id)}
  removeMember(user:Identity,familyId:string,id:string){return this.atomic(()=>{this.owner(user,familyId);if(this.one('SELECT role FROM members WHERE family_id=? AND user_id=?',familyId,id)?.role==='owner')throw new FamilyError(400,'owner_required','不能撤回家庭所有者');this.run('DELETE FROM members WHERE family_id=? AND user_id=?',familyId,id);this.revokeMemberShares(familyId,id)})}
  leave(user:Identity,familyId:string){return this.atomic(()=>{const member=this.membership(user,familyId);if(member.role==='owner')throw new FamilyError(400,'owner_required','家庭所有者请先处理档案与家庭成员');this.run('DELETE FROM members WHERE family_id=? AND user_id=?',familyId,user.id);this.revokeMemberShares(familyId,user.id)})}
  private revokeMemberShares(familyId:string,userId:string){this.run("UPDATE shares SET revoked_at=COALESCE(revoked_at,?),content_json=NULL,assets_json='[]' WHERE profile_id IN (SELECT id FROM profiles WHERE family_id=?) AND (creator_id=? OR recipient_id=?)",this.now(),familyId,userId,userId)}

  cleanup(){this.run("UPDATE shares SET content_json=NULL,assets_json='[]' WHERE expires_at<=?",this.now());this.run('DELETE FROM shares WHERE expires_at<?',this.now()-7*86400_000);this.run('DELETE FROM handoffs WHERE expires_at<?',this.now()-7*86400_000);this.run('DELETE FROM auth_sessions WHERE expires_at<=?',this.now());this.run('DELETE FROM assets WHERE committed=0 AND created_at<?',this.now()-86400_000)}
}
