from __future__ import annotations
import datetime,hashlib,json,math,runpy,sys
from pathlib import Path
import numpy as np,onnxruntime as ort
MODULE=runpy.run_path(str(Path(__file__).with_name('train-menpo39-direct-geometry.py')),run_name='headup_fusion_module')
GEOM=MODULE['GEOM'];load_records=MODULE['load_records'];GeometryDataset=MODULE['GeometryDataset'];errors_for=MODULE['errors_for'];NAMES=MODULE['NAMES'];ANGLE_POSITIONS=MODULE['ANGLE_POSITIONS'];geometry=GEOM['geometry'];canonical=GEOM['canonical'];LANDMARKS=GEOM['LANDMARKS']
ALPHAS=[.01,.1,1.,10.,100.]
def vector_from_geometry(value):
 vector=np.asarray([value['softTissueConvexityAngle'],value['eLine'][0],value['eLine'][1],value['nasolabialAngle'],value['mentolabialAngle'],value['softTissueChinProjection'],value['mandibularPlaneInclinationProxy'],value['profileVerticalProportion'][0],value['profileVerticalProportion'][1]],dtype=np.float64)
 for position,scale in ANGLE_POSITIONS.items():vector[position]/=scale
 return vector
def features_for(coords,direct,orientation):
 points=np.asarray(coords,dtype=np.float64);side='left' if orientation==0 else 'right';vertical=points[LANDMARKS['menton']]-points[LANDMARKS['brow']];axis=math.atan2(float(vertical[1]),float(vertical[0]))-math.pi/2;landmark_value=geometry(points,side,axis)
 if landmark_value is None:return None
 landmark=vector_from_geometry(landmark_value);shape=canonical(points,side,axis);origin=shape[LANDMARKS['brow']];height=max(abs(float(shape[LANDMARKS['menton'],1]-origin[1])),1e-6);shape=((shape-origin)/height).reshape(-1)
 return np.concatenate([np.asarray(direct,dtype=np.float64),landmark,shape,np.asarray([orientation],dtype=np.float64)])
def fit_ridge(x,y,alpha):
 mean=x.mean(0);std=np.maximum(x.std(0),1e-6);z=(x-mean)/std;design=np.column_stack([z,np.ones(len(z))]);eye=np.eye(design.shape[1]);eye[-1,-1]=0;coef=np.linalg.solve(design.T@design+alpha*eye,design.T@y)
 for _ in range(3):
  residual=y-design@coef;scale=max(np.median(np.abs(residual))*1.4826,1e-4);weights=np.minimum(1,1.5*scale/np.maximum(np.abs(residual),1e-8));root=np.sqrt(weights);weighted=design*root[:,None];coef=np.linalg.solve(weighted.T@weighted+alpha*eye,weighted.T@(y*root))
 return{'mean':mean,'std':std,'coef':coef}
def apply(model,x):return((x-model['mean'])/model['std'])@model['coef'][:-1]+model['coef'][-1]
def score(pred,target,position):
 scale=ANGLE_POSITIONS.get(position,1.);err=np.abs(pred-target)*scale;median=np.quantile(err,.5);p95=np.quantile(err,.95);mean=err.mean();limits=(3.,8.)if position in ANGLE_POSITIONS else(.03,.08);return max(median/limits[0],p95/limits[1])+.25*mean/limits[0]
def evaluate(model_path,geometry_path,records):
 lm=ort.InferenceSession(str(model_path),providers=['CPUExecutionProvider']);dg=ort.InferenceSession(str(geometry_path),providers=['CPUExecutionProvider']);dataset=GeometryDataset(records,False);x=[];y=[]
 for index in range(len(dataset)):
  sample=dataset[index];tensor=sample['image'].numpy()[None];coordinates=lm.run(['coordinates'],{'input':tensor})[0][0];direct=dg.run(['geometry'],{'input':tensor})[0][0];feature=features_for(coordinates,direct,int(sample['orientation']))
  if feature is None:raise RuntimeError('invalid predicted geometry feature')
  x.append(feature);y.append(sample['geometry'].numpy())
 return np.asarray(x),np.asarray(y)
def serializable(model):return{'mean':model['mean'].round(9).tolist(),'std':model['std'].round(9).tolist(),'coef':model['coef'].round(9).tolist()}
def main():
 if len(sys.argv)!=7:raise SystemExit('usage MENPO LANDMARK_ONNX GEOMETRY_ONNX RESULT CONFIG CONFIG_TMP')
 menpo,lm_path,dg_path,result_path,config_path,tmp_path=map(Path,sys.argv[1:]);records,_=load_records(menpo);validation=[r for r in records if r.split=='engineering' and r.fold==4];holdout=[r for r in records if r.split=='holdout'];xv,yv=evaluate(lm_path,dg_path,validation);xh,yh=evaluate(lm_path,dg_path,holdout);folds=np.asarray([hashlib.sha256(f'{r.orientation}/{r.image_path.stem}'.encode()).digest()[2]%5 for r in validation]);selected=[];cv={};models=[]
 for position,name in enumerate(NAMES):
  candidates={'direct':xv[:,position],'landmark':xv[:,9+position]};candidate_models={}
  for width,label in [(19,'ridge_compact'),(97,'ridge_full')]:
   for alpha in ALPHAS:
    predicted=np.empty(len(xv))
    for fold in range(5):
     train=folds!=fold;test=folds==fold;model=fit_ridge(xv[train,:width],yv[train,position],alpha);predicted[test]=apply(model,xv[test,:width])
    candidates[f'{label}_{alpha}']=predicted
  scores={key:score(value,yv[:,position],position)for key,value in candidates.items()};best=min(scores,key=scores.get)
  if best!='direct' and scores[best]>scores['direct']*.98:best='direct'
  selected.append(best);cv[name]={key:round(value,6)for key,value in scores.items()}
  if best.startswith('ridge_'):
   parts=best.rsplit('_',1);width=19 if parts[0]=='ridge_compact' else 97;model=fit_ridge(xv[:,:width],yv[:,position],float(parts[1]));models.append({'type':parts[0],'width':width,'alpha':float(parts[1]),**serializable(model)})
  else:models.append({'type':best})
 prediction=np.empty_like(yh,dtype=np.float64)
 for position,model in enumerate(models):
  if model['type']=='direct':prediction[:,position]=xh[:,position]
  elif model['type']=='landmark':prediction[:,position]=xh[:,9+position]
  else:
   native={key:np.asarray(model[key])for key in ['mean','std','coef']};prediction[:,position]=apply(native,xh[:,:model['width']])
 metrics=errors_for(prediction,yh);direct_metrics=errors_for(xh[:,:9],yh);gates={name:(metric['absoluteError']['median']<=(3 if metric['unit']=='degrees' else .03)and metric['absoluteError']['p95']<=(8 if metric['unit']=='degrees' else .08))for name,metric in metrics.items()};direct_gates={name:(metric['absoluteError']['median']<=(3 if metric['unit']=='degrees' else .03)and metric['absoluteError']['p95']<=(8 if metric['unit']=='degrees' else .08))for name,metric in direct_metrics.items()};promoted=sum(gates.values())>sum(direct_gates.values())and all(gates[name]for name in ['eLineUpper','eLineLower','verticalMidface','verticalLowerFace'])
 payload={'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policyVersion':'HEADUP-MENPO39-GEOMETRY-FUSION-1.0','partition':{'validationSelection':len(validation),'holdout':len(holdout)},'featureContract':{'direct':9,'landmarkGeometry':9,'canonicalShape':78,'orientation':1,'total':97},'selected':dict(zip(NAMES,selected)),'crossValidationScores':cv,'directHoldout':direct_metrics,'fusedHoldout':metrics,'directPassed':sum(direct_gates.values()),'fusedPassed':sum(gates.values()),'metricGates':gates,'promoted':promoted,'retention':{'imagesRetained':False,'individualPredictionsRetained':False}}
 result_path.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
 if promoted:
  config={'policyVersion':'HEADUP-PROFILE-GEOMETRY-FUSION-CONFIG-1.0','models':dict(zip(NAMES,models))};tmp_path.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf8');config_path.write_bytes(tmp_path.read_bytes())
 print(json.dumps({'selected':payload['selected'],'directPassed':payload['directPassed'],'fusedPassed':payload['fusedPassed'],'promoted':promoted,'metrics':metrics},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
