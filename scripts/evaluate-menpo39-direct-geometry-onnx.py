from __future__ import annotations
import datetime,json,runpy,sys,time
from pathlib import Path
import numpy as np,onnxruntime as ort
MODULE=runpy.run_path(str(Path(__file__).with_name('train-menpo39-direct-geometry.py')),run_name='headup_eval_direct_geometry')
load_records=MODULE['load_records'];GeometryDataset=MODULE['GeometryDataset'];errors_for=MODULE['errors_for'];NAMES=MODULE['NAMES']
def main():
 if len(sys.argv)!=4:raise SystemExit('usage MENPO_DIR MODEL RESULT')
 menpo,model,result=map(Path,sys.argv[1:]);records,_=load_records(menpo);holdout=[r for r in records if r.split=='holdout'];dataset=GeometryDataset(holdout,False);session=ort.InferenceSession(str(model),providers=['CPUExecutionProvider']);predicted=[];target=[];runtime=[]
 for index in range(len(dataset)):
  sample=dataset[index];started=time.perf_counter();value=session.run(['geometry'],{'input':sample['image'].numpy()[None]})[0][0];runtime.append((time.perf_counter()-started)*1000);predicted.append(value);target.append(sample['geometry'].numpy())
 metrics=errors_for(np.asarray(predicted),np.asarray(target));gates={name:(metric['absoluteError']['median']<=(3 if metric['unit']=='degrees' else .03)and metric['absoluteError']['p95']<=(8 if metric['unit']=='degrees' else .08))for name,metric in metrics.items()};distribution=MODULE['distribution'];payload={'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policyVersion':'HEADUP-MENPO39-DIRECT-GEOMETRY-ONNX-EVAL-1.0','source':{'profiles':len(records),'holdout':len(holdout),'imagesRetained':False},'model':'public/models/menpo39-profile-geometry-v1.onnx','holdout':{'metrics':metrics,'runtimeMs':distribution(runtime)},'metricGates':gates,'passedMetricCount':sum(gates.values()),'totalMetricComponents':len(gates),'retention':{'imagesRetained':False,'individualPredictionsRetained':False}};result.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps({'passed':payload['passedMetricCount'],'metrics':metrics,'runtimeMs':payload['holdout']['runtimeMs']},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
