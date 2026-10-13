from __future__ import annotations
import hashlib,json,runpy,sys
from datetime import datetime,timezone
from pathlib import Path
import numpy as np,onnx,onnxruntime as ort,torch,torch.nn as nn,torch.nn.functional as F
BASE=runpy.run_path(str(Path(__file__).with_name('train-menpo39-normalized-multiscale-refiners.py')),run_name='headup_export_refiners');MULTI=BASE['BASE'];V1InitializedLocalRefiner=MULTI['V1InitializedLocalRefiner'];CONFIG=MULTI['CONFIG']
class Coordinates(nn.Module):
 def __init__(self,model):super().__init__();self.model=model
 def forward(self,image):
  heatmaps=self.model(image);batch,points,height,width=heatmaps.shape;probability=F.softmax(heatmaps.reshape(batch,points,-1)*12,dim=-1);y,x=torch.meshgrid(torch.linspace(0,1,height),torch.linspace(0,1,width),indexing='ij');return torch.stack([(probability*x.reshape(1,1,-1)).sum(-1),(probability*y.reshape(1,1,-1)).sum(-1)],dim=-1)
def sha(path):
 h=hashlib.sha256()
 with path.open('rb')as f:
  for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
 return h.hexdigest()
def main():
 if len(sys.argv)!=5:raise SystemExit('usage SOURCE_PTH REFINER_PTH OUTPUT_DIR RESULT')
 source_path,refiner_path,output_dir,result_path=map(Path,sys.argv[1:]);source=torch.load(source_path,map_location='cpu',weights_only=False);payload=torch.load(refiner_path,map_location='cpu',weights_only=False);output_dir.mkdir(parents=True,exist_ok=True);results={}
 for name,config in CONFIG.items():
  model=V1InitializedLocalRefiner(source['stateDict'],config['indices']);model.load_state_dict(payload['stateDicts'][name],strict=True);wrapper=Coordinates(model).eval();size=int(config['inputSize']);torch.manual_seed(39079+list(CONFIG).index(name));example=torch.randn(1,3,size,size)
  with torch.inference_mode():reference=wrapper(example).numpy()
  path=output_dir/f'menpo39-{name}-refiner-v1.onnx';torch.onnx.export(wrapper,(example,),str(path),input_names=['input'],output_names=['coordinates'],opset_version=17,dynamo=False,external_data=False);graph=onnx.load(str(path));onnx.checker.check_model(graph);actual=ort.InferenceSession(str(path),providers=['CPUExecutionProvider']).run(['coordinates'],{'input':example.numpy()})[0];difference=float(np.max(np.abs(reference-actual)))
  if difference>1e-4:raise RuntimeError(f'{name} parity {difference}')
  results[name]={'path':str(path),'sha256':sha(path),'bytes':path.stat().st_size,'inputSize':size,'indices':config['indices'],'alpha':payload['alphas'][name],'maximumAbsoluteDifference':difference}
 result={'testedAt':datetime.now(timezone.utc).isoformat(),'policyVersion':'HEADUP-MENPO39-LOCAL-REFINERS-ONNX-1.0','researchOnly':True,'passes':True,'models':results,'notPackagedInPublic':True};result_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
