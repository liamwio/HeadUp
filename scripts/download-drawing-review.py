"""Download author-hosted public fronts and verify cached official bilateral photos."""
import hashlib,json,os,time,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parents[1];out=root/'data/validation/llm-drawing-review-2026-09-22';images=out/'images';images.mkdir(parents=True,exist_ok=True)
source=json.loads((root/'data/face-db-real-research/sources.json').read_text(encoding='utf-8'))['sources'][0]
old=[json.loads(s) for s in (root/'data/face-db-real-research/manifest.jsonl').read_text().splitlines() if s]
subjects=['013','014','017','020','021','022','026','029']
revision='fa8b78fda2d659bb74ce62fcd99c4407551d2a77';mirror='https://raw.githubusercontent.com/debruine/webmorphR.stim/'+revision+'/inst/neutral_front/'
proxy=os.environ.get('HTTPS_PROXY') or os.environ.get('ALL_PROXY') or os.environ.get('HTTP_PROXY')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy,'http':proxy}) if proxy and proxy.startswith(('http:','https:')) else urllib.request.ProxyHandler())
records=[]
for subject in subjects:
 for view in ['front','left_profile','right_profile']:
  name=subject+'_'+view+'.jpg';record=next(r for r in old if r.get('relativePath','').endswith('/'+name));target=images/name
  if view=='front':
   url=mirror+subject+'_03.jpg'
   request=urllib.request.Request(url,headers={'User-Agent':'HeadUpResearchValidation/1.0'})
   with opener.open(request,timeout=40) as response:data=response.read(5*1024*1024)
   retrieval='downloaded_author_mirror'
  else:
   url=next(f['downloadUrl'] for f in source['selectedFiles'] if f['view']==view)
   data=(root/'data/face-db-real-research'/record['relativePath']).read_bytes()
   if hashlib.sha256(data).hexdigest()!=record['sha256']:raise RuntimeError('Cached source checksum mismatch')
   retrieval='verified_official_cache_after_http403'
  if not data.startswith(b'\xff\xd8') or len(data)>4*1024*1024:raise RuntimeError('Invalid JPEG')
  target.write_bytes(data);digest=hashlib.sha256(data).hexdigest()
  records.append({'id':name[:-4],'subject':subject,'view':view,'path':'images/'+name,'downloadUrl':url,'retrieval':retrieval,'sha256':digest,'matchesExistingOfficialHash':digest==record['sha256'],'bytes':len(data)})
  print(json.dumps({'case':name,'retrieval':retrieval,'bytes':len(data)}),flush=True)
manifest={'version':'HEADUP-LLM-DRAWING-REVIEW-1','source':{'name':source['name'],'url':source['sourceUrl'],'license':source['license'],'attribution':source['attribution'],'scope':'consented adult research images','authorMirror':'https://github.com/debruine/webmorphR.stim','mirrorRevision':revision},'selection':'fixed8 available IDs chosen before analysis; all3 neutral views; no result filtering','notIndependentHoldout':True,'retrievalNote':'Official Figshare archive GET returned403; fresh fronts from verified author mirror, bilateral profiles from checksum-verified official cache. No private user photos.','downloadedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'counts':{'freshDownloads':8,'verifiedCachedProfiles':16,'total':24},'cases':records}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'total':len(records),'output':str(out)}),flush=True)
