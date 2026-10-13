import {SHARE_PROTOCOL} from '../src/family/shareContract.ts'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {createHash,timingSafeEqual} from 'node:crypto'
import {FamilyDatabase,FamilyError} from './familyDb.ts'
import {cloudId,cloudMediaKey} from '../src/family/cloudContract.ts'
import {preflightImageFile} from '../src/lib/imageInputPreflight.ts'
import {appOrigins} from './config.ts'

const COOKIE='headup_session'
export function authCookie(req:IncomingMessage,name=COOKIE){const match=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);return match&&/^[A-Za-z0-9_-]{43}$/.test(match)?match:undefined}
const send=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});res.end(JSON.stringify(body))}
const error=(status:number,code:string,message:string)=>{throw new FamilyError(status,code,message)}
async function bytes(req:IncomingMessage,limit:number){if(Number(req.headers['content-length'])>limit)error(413,'body_limit','提交内容过大');let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>limit)error(413,'body_limit','提交内容过大');chunks.push(chunk)}return Buffer.concat(chunks)}
async function json(req:IncomingMessage,limit=16384){if(!req.headers['content-type']?.startsWith('application/json'))error(415,'content_type','需要JSON请求');try{const value=JSON.parse((await bytes(req,limit)).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))error(400,'invalid_json','请求必须是JSON对象');return value}catch(e){if(e instanceof FamilyError)throw e;return error(400,'invalid_json','请求内容不是有效JSON')}}
const version=(v:any)=>{if(!Number.isSafeInteger(v)||v<1)error(400,'version_required','请提供已读取的档案版本');return v as number}
const sameSecret=(a:unknown,b:string)=>typeof a==='string'&&a.length<=256&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest())
export function createFamilyHandler(db:FamilyDatabase,env:NodeJS.ProcessEnv=process.env,cookieName=COOKIE){
  if(!/^[a-zA-Z0-9_-]{1,50}$/.test(cookieName))throw new Error('Invalid cookie name')
  const origins=appOrigins(env),secure=env.HEADUP_COOKIE_SECURE==='1'
  for(const origin of origins){let url:URL;try{url=new URL(origin)}catch{throw new Error('HEADUP_APP_ORIGINS包含无效来源')};if(url.origin!==origin||!['http:','https:'].includes(url.protocol))throw new Error('HEADUP_APP_ORIGINS必须是完整来源，不能带路径');if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('远程家庭服务必须使用HTTPS');if(url.protocol==='https:'&&!secure)throw new Error('HTTPS部署必须设置HEADUP_COOKIE_SECURE=1')}
  const setupCode=env.HEADUP_REGISTRATION_CODE??'',buckets=new Map<string,{at:number;n:number}>();let hashing=0
  const rate=(key:string,max:number)=>{const now=Date.now();for(const[k,v]of buckets)if(now-v.at>600000)buckets.delete(k);const value=buckets.get(key)??{at:now,n:0};if(++value.n>max)error(429,'rate_limited','操作较多，请稍后再试');buckets.set(key,value)}
  const cookie=(res:ServerResponse,token:string,clear=false)=>res.setHeader('Set-Cookie',`${cookieName}=${clear?'':token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:30*86400}${secure?'; Secure':''}`)
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    if(!req.url?.startsWith('/api/family/'))return false
    try{
      const url=new URL(req.url,'http://internal'),segments=url.pathname.slice('/api/family/'.length).split('/').filter(Boolean).map(decodeURIComponent),method=req.method??'GET',write=!['GET','HEAD'].includes(method),origin=req.headers.origin??'',token=authCookie(req,cookieName),user=db.authenticate(token)
      if(write&&(!origins.includes(origin)||req.headers['x-headup-request']!=='1'))error(403,'request_denied','当前页面不允许提交此请求')
      if(segments.join('/')==='auth/logout-proof'&&method==='POST'){rate('logout:'+req.socket.remoteAddress,60);const body=await json(req);const clear=Boolean(token&&user?.id===body.userId&&db.csrfFor(token)===body.proof);db.logoutProof(body.userId,body.proof);if(clear)cookie(res,'',true);send(res,200,{ok:true,currentSessionCleared:clear});return true}
      const publicAuth=segments.length===2&&segments[0]==='auth'&&['register','login','recover'].includes(segments[1]??'')
      if(segments.join('/')==='config'&&method==='GET'){send(res,200,{ready:true,cookieSecure:secure,registration:setupCode?'code_or_invite':'local_or_invite',protocol:'HEADUP-SYNC-1',handoffProtocol:'HEADUP-HANDOFF-1',shareProtocol:SHARE_PROTOCOL});return true}
      if(publicAuth){
        if(method!=='POST')error(405,'method_not_allowed','请求方法不支持')
        rate('auth:'+req.socket.remoteAddress,30);if(hashing>=2)error(429,'rate_limited','登录服务繁忙，请稍后再试')
        const body=await json(req);if(hashing>=2)error(429,'rate_limited','登录服务繁忙，请稍后再试');hashing++
        try{
          if(segments[1]==='register'){
            let local=false;try{local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')&&['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)}catch{}
            if(!(setupCode?sameSecret(body.registrationCode,setupCode):local)&&!db.canRegisterWithInvite(body.username,body.inviteToken))error(403,'registration_code_required','需要服务器管理员提供的注册代码或有效邀请')
            const result=await db.register(body.username,body.password,body.displayName);send(res,201,result)
          }else if(segments[1]==='login'){const result=await db.login(body.username,body.password);cookie(res,result.token);send(res,200,{user:result.user,csrf:result.csrf})}
          else send(res,200,await db.recover(body.username,body.recoveryCode,body.password))
        }finally{hashing--}return true
      }
      if(!user||!token)error(401,'login_required','请先登录家庭同步账号')
      const actor=user!,sessionToken=token!
      if(write&&!db.verifyCsrf(sessionToken,String(req.headers['x-headup-csrf']??'')))error(403,'csrf_invalid','会话校验已失效，请刷新登录状态后重试')
      if(write&&req.headers['x-headup-account']&&req.headers['x-headup-account']!==actor.id)error(409,'account_changed','登录账号已变化，本次操作未执行；请切回对应账号后重试')
      rate('user:'+actor.id,600)
      const path=segments.join('/')
      if(path==='shares/preview'&&method==='POST'){const body=await json(req,128*1024);if(!cloudId(body.profileId))error(400,'share_invalid','档案编号无效');send(res,200,db.previewShare(actor,body.profileId,version(body.version),body.scope,body.recipient));return true}
      if(path==='shares'&&method==='POST'){const body=await json(req,128*1024);if(!cloudId(body.profileId))error(400,'share_invalid','档案编号无效');send(res,201,db.createShare(actor,body.profileId,version(body.version),body.id,body.token,body.recipient,body.ttlHours,body.scope,body.consentVersion));return true}
      if(path==='shares/read'&&method==='POST'){const body=await json(req);send(res,200,db.readShare(actor,body.token));return true}
      if(path==='shares/read-photo'&&method==='POST'){const body=await json(req),asset=db.readSharedPhoto(actor,body.token,body.ref);res.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline','Cross-Origin-Resource-Policy':'same-origin'});res.end(asset.data);return true}
      if(segments[0]==='shares'&&segments.length===2&&cloudId(segments[1])&&method==='DELETE'){send(res,200,db.revokeShare(actor,segments[1]));return true}
      if(path==='handoffs'&&method==='POST'){const body=await json(req);if(!cloudId(body.profileId))error(400,'handoff_invalid','档案编号无效');send(res,201,db.createHandoff(actor,body.profileId,version(body.version),body.id,body.token,body.side));return true}
      if(path==='handoffs/inspect'&&method==='POST'){const body=await json(req);send(res,200,db.inspectHandoff(actor,body.token));return true}
      if(path==='handoffs/claim'&&method==='POST'){const body=await json(req);send(res,200,db.claimHandoff(actor,body.token,body.claimId));return true}
      if(segments[0]==='handoffs'&&cloudId(segments[1])){if(segments.length===2&&method==='GET'){send(res,200,db.handoffStatus(actor,segments[1]));return true}if(segments.length===2&&method==='DELETE'){send(res,200,db.revokeHandoff(actor,segments[1]));return true}if(segments[2]==='complete'&&segments.length===3&&method==='POST'){const body=await json(req);send(res,200,db.completeHandoff(actor,segments[1],body.claimId,body.sessionId));return true}}
      if(path==='me'&&method==='GET'){send(res,200,{user:actor,csrf:db.csrfFor(sessionToken),families:db.families(actor)});return true}
      if(path==='auth/logout'&&method==='POST'){db.logout(sessionToken);cookie(res,'',true);send(res,200,{ok:true});return true}
      if(path==='families'&&method==='GET'){send(res,200,{families:db.families(actor)});return true}
      if(path==='families'&&method==='POST'){const body=await json(req);send(res,201,db.createFamily(actor,body.name));return true}
      if(segments[0]==='families'&&cloudId(segments[1])){
        const familyId=segments[1],action=segments[2]
        if(action==='deletion-preview'&&segments.length===3&&method==='GET'){send(res,200,db.familyDeletionPreview(actor,familyId));return true}
        if(action==='deletions'&&segments.length===3&&method==='POST'){const body=await json(req);send(res,200,db.deleteFamilyProfiles(actor,familyId,body.id,body.scopeHash,body.protocol));return true}
        if(action==='deletions'&&segments.length===4&&cloudId(segments[3])&&method==='GET'){send(res,200,{receipt:db.familyDeletionReceipt(actor,familyId,segments[3])});return true}
        if(action==='profiles'&&segments.length===3){if(method==='GET')send(res,200,{profiles:db.listProfiles(actor,familyId)});else if(method==='POST'){const body=await json(req,128*1024);send(res,201,db.createProfile(actor,familyId,body.profile,body.consentVersion))}else error(405,'method_not_allowed','请求方法不支持');return true}
        if(action==='members'&&method==='GET'&&segments.length===3){send(res,200,{members:db.members(actor,familyId)});return true}
        if(action==='members'&&method==='DELETE'&&cloudId(segments[3])){db.removeMember(actor,familyId,segments[3]);send(res,200,{ok:true});return true}
        if(action==='leave'&&method==='POST'){db.leave(actor,familyId);send(res,200,{ok:true});return true}
        if(action==='invites'&&segments.length===3){if(method==='GET')send(res,200,{invites:db.invites(actor,familyId)});else if(method==='POST'){const body=await json(req);send(res,201,db.invite(actor,familyId,body.username,body.role,body.profileIds))}else error(405,'method_not_allowed','请求方法不支持');return true}
        if(action==='invites'&&method==='DELETE'&&cloudId(segments[3])){db.revokeInvite(actor,familyId,segments[3]);send(res,200,{ok:true});return true}
      }
      if(segments[0]==='invites'&&segments[1]==='inspect'&&method==='POST'){const body=await json(req);if(typeof body.token!=='string'||body.token.length>100)error(400,'invalid_input','邀请格式无效');const invite=db.inspectInvite(actor,body.token);send(res,200,{id:invite.id,familyName:invite.name,role:invite.role,profileIds:JSON.parse(invite.scopes),profiles:invite.profiles,expiresAt:invite.expires_at});return true}
      if(segments[0]==='invites'&&segments[1]==='accept'&&method==='POST'){const body=await json(req);if(typeof body.token!=='string'||body.token.length>100)error(400,'invalid_input','邀请格式无效');send(res,200,db.acceptInvite(actor,body.token,body.consentVersion));return true}
      if(segments[0]==='profiles'&&cloudId(segments[1])){
        const id=segments[1]
        if(segments[2]==='shares'&&segments.length===3&&method==='GET'){send(res,200,{shares:db.listShares(actor,id)});return true}
        if(segments[2]==='mutations'&&cloudId(segments[3])&&segments.length===4){if(method==='GET')send(res,200,{receipt:db.receipt(actor,id,segments[3])});else if(method==='DELETE')send(res,200,{receipt:db.cancelMutation(actor,id,segments[3])});else error(405,'method_not_allowed','请求方法不支持');return true}
        if(segments.length===2&&method==='GET'){const result=db.getSnapshot(actor,id);res.setHeader('ETag',`"${result.version}"`);if(req.headers['if-none-match']===`"${result.version}"`){res.writeHead(304,{'Cache-Control':'no-store'});res.end()}else send(res,200,result);return true}
        if(segments.length===2&&method==='PUT'){db.getSnapshot(actor,id);const body=await json(req,32*1024*1024);if(!cloudId(body.mutationId))error(400,'mutation_required','同步请求编号无效');send(res,200,db.commit(actor,id,version(body.version),body.mutationId,body.snapshot));return true}
        if(segments.length===2&&method==='DELETE'){const body=await json(req);send(res,200,db.deleteProfile(actor,id,version(body.version)));return true}
        if(segments[2]==='media'){
          const key=url.searchParams.get('key');if(!cloudMediaKey(key))error(400,'media_key_invalid','照片编号无效')
          if(method==='GET'){const asset=db.getAsset(actor,id,key!);res.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline','Cross-Origin-Resource-Policy':'same-origin'});res.end(asset.data);return true}
          if(method==='PUT'){const expectedVersion=version(Number(req.headers['x-headup-version'])),before=db.getSnapshot(actor,id);if(before.deleted)error(410,'profile_deleted','该档案已删除');if(before.version!==expectedVersion)throw new FamilyError(409,'version_conflict','档案已更新，未接受过期照片上传',{version:before.version});const mime=req.headers['content-type']?.split(';')[0]??'';if(!['image/png','image/jpeg','image/webp','image/avif'].includes(mime))error(415,'image_type','不支持这种照片格式');const data=await bytes(req,30*1024*1024);try{await preflightImageFile(new File([new Uint8Array(data)],'upload',{type:mime}))}catch{error(400,'image_invalid','照片内容或尺寸无效')};send(res,200,db.putAsset(actor,id,key!,mime,data,expectedVersion));return true}
        }
      }
      error(404,'not_found','接口不存在')
    }catch(e){if(!res.headersSent&&!res.destroyed){if(e instanceof FamilyError)send(res,e.status,{error:e.code,message:e.message,details:e.details});else send(res,500,{error:'internal_error',message:'服务暂时无法完成请求，本机记录仍保留'})}}
    return true
  }
}
