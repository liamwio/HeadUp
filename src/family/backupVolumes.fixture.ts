import type {Archive} from './backup'
import {createProfile,createSession,defaultProtocol} from './model'
import {createRevision} from './revisions'
export function archiveFixture():Archive {
  const profile=createProfile({nickname:'测试私密昵称',guardianConfirmed:true,childInformed:true,storage:true})
  const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDaugsVFfkr4h7hIFCBKSh4etpohuwAdUrsgv1LtEN2IDqFdmFepfoBmxA9YrsQr1LdAM2oHpFdqHeJboBG1C9IrtQ7xLdgA2oXpFdqHeJbsAGVK/ILtS7RDdgA6pXZBfqXaIbsAHVK7IL9S7RDdiA6hXZhXqX6AZsQPWK7EK9S3QDNqB6RXah3iW6ARtQveIfHt+zMNP9NlL/AAAAAElFTkSuQmCC'),c=>c.charCodeAt(0)),blob=new Blob([png],{type:'image/png'})
  const capture={id:'front' as const,label:'正面',hint:'',eyebrow:'',url:'blob:fixture'}
  const root=createSession({profileId:profile.id,recordedOn:'2026-09-17',kind:'memory',recordedBy:'together',note:'<script>私密备注</script>',protocol:defaultProtocol()},[capture])
  root.captures[0].mediaId=root.id+'/front'
  const revision=createRevision(root,[capture],'reanalyze',['front']);revision.captures[0].mediaId=revision.id+'/front'
  return{profiles:[profile],sessions:[root,revision],plans:[],events:[],media:[root,revision].map(s=>({id:s.captures[0].mediaId!,sessionId:s.id,profileId:profile.id,blob,originalBlob:blob}))}
}
