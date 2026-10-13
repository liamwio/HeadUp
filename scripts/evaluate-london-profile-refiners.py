from __future__ import annotations
import datetime,json,math,runpy,sys,time
from pathlib import Path
from types import SimpleNamespace
import cv2,numpy as np,onnxruntime as ort,torch
BASE=runpy.run_path(str(Path(__file__).with_name('train-menpo39-normalized-multiscale-refiners.py')),run_name='headup_london_refiners');MULTI=BASE['BASE'];CAL=runpy.run_path(str(Path(__file__).with_name('calibrate-menpo39-yunet-crop.py')),run_name='headup_london_crop');GEOM=MULTI['GEOMETRY'];V1=MULTI['V1InitializedLocalRefiner'];CONFIG=MULTI['CONFIG'];MultiScaleDataset=BASE['V1NormalizedMultiScaleDataset'];local_predict=MULTI['local_predict'];blend=MULTI['blend'];geometry=GEOM['geometry'];distribution=MULTI['TRAIN']['distribution'];detect=CAL['detect'];crop_matrix=CAL['crop_matrix'];tensor_for=CAL['tensor_for'];restore=CAL['restore']
CROP={'left':(1.138812414528869,.03847504237478136,.11833929151974497),'right':(1.1504958141994608,-.03945996063163659,.12225221823707466)}
REGION_INDICES={
 'forehead':[12,13,14,15,16,17],
 'nasalDorsum':[17,18,19],
 'maxillarySupport':[21,22,23,24,25,26,27],
 'mandibularChin':[4,5,6,7,8,9,10],
}
def geom(points,side):
 vertical=points[8]-points[14];axis=math.atan2(float(vertical[1]),float(vertical[0]))-math.pi/2;return geometry(points,side,axis)
def canonical_shape(points,side):
 value=GEOM['canonical'](points,side,math.atan2(float((points[8]-points[14])[1]),float((points[8]-points[14])[0]))-math.pi/2);origin=value[14];height=max(abs(float(value[8,1]-origin[1])),1e-6);return(value-origin)/height
def region_metrics(points,side):
 value=canonical_shape(points,side)
 def angle(vertex,first,second):
  left,right=first-vertex,second-vertex;denominator=float(np.linalg.norm(left)*np.linalg.norm(right))
  return math.degrees(math.acos(float(np.clip(np.dot(left,right)/max(denominator,1e-8),-1,1))))
 def line_distance(point,start,end):
  line=end-start;length=float(np.linalg.norm(line))
  return abs(float(line[1]*point[0]-line[0]*point[1]+end[0]*start[1]-end[1]*start[0]))/max(length,1e-8)
 def signed_line_distance(point,start,end):
  line=end-start;length=float(np.linalg.norm(line));normal=np.asarray([line[1],-line[0]],dtype=np.float64)/max(length,1e-8)
  if normal[0]<0:normal=-normal
  return float(np.dot(point-start,normal))
 e_line=value[19]-value[10]
 upper_e=signed_line_distance(value[27],value[19],value[10]);lower_e=signed_line_distance(value[33],value[19],value[10]);lower_face=max(float(np.linalg.norm(value[21]-value[8])),1e-8)
 return {
  'foreheadContourTurnAngle':angle(value[14],value[12],value[17]),
  'nasalDorsumDeviation':line_distance(value[18],value[17],value[19]),
  'foreheadNoseChinAngle':angle(value[19],value[14],value[10]),
  'eLineInclinationAngle':math.degrees(math.atan2(abs(float(e_line[1])),max(abs(float(e_line[0])),1e-8))),
  'upperLipELineAngle':angle(value[27],value[19],value[10]),
  'lowerLipELineAngle':angle(value[33],value[19],value[10]),
  'nasofrontalAngle':angle(value[17],value[14],value[19]),
  'nasalDorsumLengthRatio':float(np.linalg.norm(value[19]-value[17])),
  'nasalProjectionRatio':line_distance(value[19],value[17],value[21]),
  'upperLowerLipProjectionDifference':upper_e-lower_e,
  'mentolabialFoldDepthRatio':line_distance(value[11],value[33],value[10]),
  'chinHeightLowerFaceRatio':float(np.linalg.norm(value[10]-value[8]))/lower_face,
 }
def metric_diff(a,b,name):
 left,right=a[name],b[name]
 return float(np.max(np.abs(left-right)))if isinstance(left,np.ndarray)else abs(float(left)-float(right))
def region_shape_rms(left,right,indices):
 delta=left[np.asarray(indices)]-right[np.asarray(indices)]
 return float(np.sqrt(np.mean(np.sum(delta*delta,axis=1))))
def main():
 if len(sys.argv)!=8:raise SystemExit('usage LONDON GLOBAL SOURCE REFINER YUNET RESULT UNUSED')
 london,global_path,source_path,refiner_path,yunet_path,result_path,_=map(Path,sys.argv[1:]);files=sorted(london.glob('*_profile.jpg'));assert len(files)==204;detector=ort.InferenceSession(str(yunet_path),providers=['CPUExecutionProvider']);session=ort.InferenceSession(str(global_path),providers=['CPUExecutionProvider']);records=[];global_predictions=[];meta=[];rejected={};runtime=[]
 for path in files:
  stem=path.stem;subject=stem[:3];side='left'if'_left_profile'in stem else'right';image=cv2.imread(str(path));box,score=detect(detector,image)
  if box is None or score<.85:rejected['yunet']=rejected.get('yunet',0)+1;continue
  matrix,inverse=crop_matrix(box,*CROP[side]);started=time.perf_counter();coords=session.run(['coordinates'],{'input':tensor_for(image,matrix)})[0][0];runtime.append((time.perf_counter()-started)*1000);prediction=restore(coords,inverse);direction=np.sign(prediction[19,0]-prediction[10,0]);expected=1 if side=='right'else-1
  if direction!=expected:rejected['direction']=rejected.get('direction',0)+1;continue
  records.append(SimpleNamespace(image_path=path,points=prediction,orientation=side));global_predictions.append(prediction);meta.append((subject,side))
 global_predictions=np.asarray(global_predictions);source=torch.load(source_path,map_location='cpu',weights_only=False);payload=torch.load(refiner_path,map_location='cpu',weights_only=False);models={}
 for name,config in CONFIG.items():model=V1(source['stateDict'],config['indices']);model.load_state_dict(payload['stateDicts'][name]);model.eval();models[name]=model
 local={name:local_predict(models[name],MultiScaleDataset(records,global_predictions,name,augment=False),12 if int(config['inputSize'])==256 else 24)for name,config in CONFIG.items()};base={'predictions':global_predictions,'ground_truths':global_predictions.copy(),'diagonals':np.ones(len(records)),'orientations':np.asarray([0 if side=='left' else 1 for _,side in meta])};candidate=blend(base,local,payload['alphas'])['predictions']
 index={(subject,side):i for i,(subject,side)in enumerate(meta)};baseline_rms=[];candidate_rms=[];baseline_region_rms={name:[]for name in REGION_INDICES};candidate_region_rms={name:[]for name in REGION_INDICES};metric_names=['softTissueConvexityAngle','eLine','nasolabialAngle','mentolabialAngle','softTissueChinProjection','mandibularPlaneInclinationProxy','profileVerticalProportion','foreheadContourTurnAngle','nasalDorsumDeviation','foreheadNoseChinAngle','eLineInclinationAngle','upperLipELineAngle','lowerLipELineAngle','nasofrontalAngle','nasalDorsumLengthRatio','nasalProjectionRatio','upperLowerLipProjectionDifference','mentolabialFoldDepthRatio','chinHeightLowerFaceRatio'];base_diffs={n:[]for n in metric_names};candidate_diffs={n:[]for n in metric_names};pairs=0
 for subject in sorted({subject for subject,_ in meta}):
  if(subject,'left')not in index or(subject,'right')not in index:continue
  li,ri=index[(subject,'left')],index[(subject,'right')];bl,br=canonical_shape(global_predictions[li],'left'),canonical_shape(global_predictions[ri],'right');cl,cr=canonical_shape(candidate[li],'left'),canonical_shape(candidate[ri],'right');baseline_rms.append(float(np.sqrt(np.mean(np.sum((bl-br)**2,axis=1)))));candidate_rms.append(float(np.sqrt(np.mean(np.sum((cl-cr)**2,axis=1)))));[baseline_region_rms[name].append(region_shape_rms(bl,br,indices))for name,indices in REGION_INDICES.items()];[candidate_region_rms[name].append(region_shape_rms(cl,cr,indices))for name,indices in REGION_INDICES.items()];bg_l,bg_r=geom(global_predictions[li],'left'),geom(global_predictions[ri],'right');cg_l,cg_r=geom(candidate[li],'left'),geom(candidate[ri],'right')
  if None in [bg_l,bg_r,cg_l,cg_r]:continue
  bg_l.update(region_metrics(global_predictions[li],'left'));bg_r.update(region_metrics(global_predictions[ri],'right'));cg_l.update(region_metrics(candidate[li],'left'));cg_r.update(region_metrics(candidate[ri],'right'))
  for name in metric_names:base_diffs[name].append(metric_diff(bg_l,bg_r,name));candidate_diffs[name].append(metric_diff(cg_l,cg_r,name))
  pairs+=1
 result={'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policyVersion':'HEADUP-LONDON-PROFILE-REFINER-PAIR-1.1','source':{'subjects':102,'images':204,'imagesCopied':False},'eligibleImages':len(records),'pairedSubjects':pairs,'rejected':rejected,'alphas':payload['alphas'],'regionPathContract':{name:{'indices':indices,'meaning':'mirrored left/right repeatability normalized by visible profile height; not landmark ground-truth accuracy'}for name,indices in REGION_INDICES.items()},'baseline':{'mirroredShapeRms':distribution(baseline_rms),'pairedRegionShapeRms':{n:distribution(v)for n,v in baseline_region_rms.items()},'pairedMetricDifference':{n:distribution(v)for n,v in base_diffs.items()}},'candidate':{'mirroredShapeRms':distribution(candidate_rms),'pairedRegionShapeRms':{n:distribution(v)for n,v in candidate_region_rms.items()},'pairedMetricDifference':{n:distribution(v)for n,v in candidate_diffs.items()}},'globalRuntimeMs':distribution(runtime),'retention':{'imagesCopied':False,'individualPredictionsRetained':False}};result_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps({'eligible':len(records),'pairs':pairs,'baselineRms':result['baseline']['mirroredShapeRms'],'candidateRms':result['candidate']['mirroredShapeRms'],'baselineRegions':result['baseline']['pairedRegionShapeRms'],'candidateRegions':result['candidate']['pairedRegionShapeRms'],'baselineMetric':result['baseline']['pairedMetricDifference'],'candidateMetric':result['candidate']['pairedMetricDifference']},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
