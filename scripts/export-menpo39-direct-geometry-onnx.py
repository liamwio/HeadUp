from __future__ import annotations
import hashlib,json,runpy,sys
from datetime import datetime,timezone
from pathlib import Path
import numpy as np,onnx,onnxruntime as ort,torch
import torch.nn as nn

MODULE=runpy.run_path(str(Path(__file__).with_name('train-menpo39-direct-geometry.py')),run_name='headup_export_direct_geometry')
DirectGeometryModel=MODULE['DirectGeometryModel'];MobileNet39Heatmaps=MODULE['MobileNet39Heatmaps'];NAMES=MODULE['NAMES']
class FixedAdaptivePool4(nn.Module):
 def forward(self,value):
  rows=torch.stack([value[:,:,0:2,:].mean(2),value[:,:,1:4,:].mean(2),value[:,:,3:6,:].mean(2),value[:,:,5:7,:].mean(2)],dim=2)
  return torch.stack([rows[:,:,:,0:2].mean(3),rows[:,:,:,1:4].mean(3),rows[:,:,:,3:6].mean(3),rows[:,:,:,5:7].mean(3)],dim=3)
def sha(path):
 h=hashlib.sha256()
 with path.open('rb')as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def main():
 if len(sys.argv)!=5:raise SystemExit('usage CHECKPOINT OUTPUT MANIFEST RESULT')
 checkpoint,output,manifest_path,result_path=map(Path,sys.argv[1:]);payload=torch.load(checkpoint,map_location='cpu',weights_only=True);base=MobileNet39Heatmaps(pretrained=False);model=DirectGeometryModel(base.features,torch.zeros(9),torch.ones(9));model.load_state_dict(payload['stateDict'],strict=True);model.head[3]=FixedAdaptivePool4();model.eval();torch.manual_seed(39103);example=torch.randn(1,3,224,224)
 with torch.inference_mode():reference=model(example).numpy()
 output.parent.mkdir(parents=True,exist_ok=True);torch.onnx.export(model,(example,),str(output),input_names=['input'],output_names=['geometry'],opset_version=17,dynamo=False,external_data=False,do_constant_folding=True);graph=onnx.load(str(output));onnx.checker.check_model(graph);session=ort.InferenceSession(str(output),providers=['CPUExecutionProvider']);actual=session.run(['geometry'],{'input':example.numpy()})[0];difference=float(np.max(np.abs(reference-actual)))
 if difference>1e-4 or actual.shape!=(1,9):raise RuntimeError(f'parity failed {difference}/{actual.shape}')
 manifest={'policyVersion':'HEADUP-MENPO39-DIRECT-GEOMETRY-ONNX-1.0','createdAt':datetime.now(timezone.utc).isoformat(),'model':{'path':'models/menpo39-profile-geometry-v1.onnx','sha256':sha(output),'bytes':output.stat().st_size,'input':{'shape':[1,3,224,224],'normalization':'ImageNet RGB'},'output':{'name':'geometry','shape':[1,9],'names':NAMES,'angleScales':{'softTissueConvexityAngle':180,'nasolabialAngle':180,'mentolabialAngle':180,'mandibularPlaneInclinationProxy':90}}},'sourceCheckpoint':{'sha256':sha(checkpoint)}};manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8');result={'testedAt':datetime.now(timezone.utc).isoformat(),'policyVersion':'HEADUP-DIRECT-GEOMETRY-ONNX-EXPORT-1.0','passes':True,'onnxCheckerPassed':True,'maximumAbsoluteDifference':difference,'threshold':1e-4,'model':manifest['model']};result_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
