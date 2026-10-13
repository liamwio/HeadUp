from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import runpy
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

TRAIN=runpy.run_path(str(Path(__file__).with_name('train-menpo39-profile-landmarks.py')),run_name='headup_direct_geometry_train')
GEOM=runpy.run_path(str(Path(__file__).with_name('benchmark-menpo39-profile-geometry.py')),run_name='headup_direct_geometry_helpers')
load_records=TRAIN['load_records'];BaseDataset=TRAIN['MenpoProfileDataset'];MobileNet39Heatmaps=TRAIN['MobileNet39Heatmaps'];distribution=TRAIN['distribution'];sha256=TRAIN['sha256'];geometry=GEOM['geometry'];LANDMARKS=GEOM['LANDMARKS']

SEED=39103
NAMES=['softTissueConvexityAngle','eLineUpper','eLineLower','nasolabialAngle','mentolabialAngle','softTissueChinProjection','mandibularPlaneInclinationProxy','verticalMidface','verticalLowerFace']
ANGLE_POSITIONS={0:180.0,3:180.0,4:180.0,6:90.0}

def vector_for(points:np.ndarray,orientation:str)->np.ndarray:
    vertical=points[LANDMARKS['menton']]-points[LANDMARKS['brow']]
    axis=math.atan2(float(vertical[1]),float(vertical[0]))-math.pi/2
    value=geometry(points,orientation,axis)
    if value is None: raise RuntimeError('invalid ground-truth geometry')
    vector=np.asarray([value['softTissueConvexityAngle'],value['eLine'][0],value['eLine'][1],value['nasolabialAngle'],value['mentolabialAngle'],value['softTissueChinProjection'],value['mandibularPlaneInclinationProxy'],value['profileVerticalProportion'][0],value['profileVerticalProportion'][1]],dtype=np.float32)
    for position,scale in ANGLE_POSITIONS.items():vector[position]/=scale
    return vector

class GeometryDataset(Dataset):
    def __init__(self,records,augment:bool):
        self.records=records;self.base=BaseDataset(records,augment=augment);self.augment=augment
    def set_epoch(self,epoch:int):self.base.set_epoch(epoch)
    def __len__(self):return len(self.records)
    def __getitem__(self,index):
        sample=self.base[index]
        sample['geometry']=torch.from_numpy(vector_for(self.records[index].points,self.records[index].orientation))
        return sample

class DirectGeometryModel(nn.Module):
    def __init__(self,features:nn.Module,mean:torch.Tensor,std:torch.Tensor):
        super().__init__();self.features=features
        self.head=nn.Sequential(nn.Conv2d(576,128,1,bias=False),nn.BatchNorm2d(128),nn.Hardswish(),nn.AdaptiveAvgPool2d((4,4)),nn.Flatten(),nn.Linear(128*4*4,256),nn.Hardswish(),nn.Dropout(.15),nn.Linear(256,len(NAMES)))
        self.register_buffer('target_mean',mean);self.register_buffer('target_std',std)
    def forward(self,image):return self.head(self.features(image))*self.target_std+self.target_mean

def errors_for(predicted:np.ndarray,target:np.ndarray)->dict[str,dict[str,float]]:
    result={}
    for index,name in enumerate(NAMES):
        scale=ANGLE_POSITIONS.get(index,1.0)
        errors=np.abs(predicted[:,index]-target[:,index])*scale
        result[name]={'unit':'degrees' if index in ANGLE_POSITIONS else 'absolute_ratio','absoluteError':distribution(errors.tolist())}
    return result

def score(metrics):
    values=[]
    for metric in metrics.values():
        limit=(3,8) if metric['unit']=='degrees' else (.03,.08)
        values.append(max(metric['absoluteError']['median']/limit[0],metric['absoluteError']['p95']/limit[1]))
    return max(values),sum(values)/len(values)

def predict(model,dataset):
    loader=DataLoader(dataset,batch_size=32,shuffle=False,num_workers=0);predicted=[];target=[]
    model.eval()
    with torch.inference_mode():
        for batch in loader:predicted.append(model(batch['image']).numpy());target.append(batch['geometry'].numpy())
    return np.concatenate(predicted),np.concatenate(target)

def main():
    if len(sys.argv)!=6:raise SystemExit('usage: train.py MENPO_DIR BASE_MODEL RESULT_JSON MODEL_PATH MODEL_TMP')
    menpo_dir,base_path,result_path,model_path,model_tmp=map(Path,sys.argv[1:])
    torch.manual_seed(SEED);np.random.seed(SEED);torch.set_num_threads(min(8,os.cpu_count()or 1));torch.set_num_interop_threads(1)
    records,_=load_records(menpo_dir);train_records=[r for r in records if r.split=='engineering' and r.fold!=4];validation_records=[r for r in records if r.split=='engineering' and r.fold==4];holdout_records=[r for r in records if r.split=='holdout']
    train_targets=np.vstack([vector_for(r.points,r.orientation) for r in train_records]);mean=torch.from_numpy(train_targets.mean(axis=0).astype(np.float32));std=torch.from_numpy(np.maximum(train_targets.std(axis=0),1e-4).astype(np.float32))
    checkpoint=torch.load(base_path,map_location='cpu',weights_only=False);base=MobileNet39Heatmaps(pretrained=False);base.load_state_dict(checkpoint['stateDict'])
    model=DirectGeometryModel(base.features,mean,std)
    for parameter in model.features.parameters():parameter.requires_grad=False
    training=GeometryDataset(train_records,True);validation=GeometryDataset(validation_records,False)
    optimizer=torch.optim.AdamW(model.head.parameters(),lr=8e-4,weight_decay=2e-4)
    curve=[];best=(float('inf'),float('inf'));best_epoch=0;started=time.perf_counter()
    model_tmp.parent.mkdir(parents=True,exist_ok=True)
    for epoch in range(1,19):
        if epoch==5:
            for parameter in list(model.features.children())[8:]:
                for value in parameter.parameters():value.requires_grad=True
            optimizer=torch.optim.AdamW([{'params':model.head.parameters(),'lr':4e-4},{'params':[p for block in list(model.features.children())[8:] for p in block.parameters()],'lr':2e-5}],weight_decay=2e-4)
        training.set_epoch(epoch);model.train();losses=[];generator=torch.Generator().manual_seed(SEED+epoch)
        for batch in DataLoader(training,batch_size=24,shuffle=True,generator=generator,num_workers=0):
            optimizer.zero_grad(set_to_none=True);prediction=model(batch['image']);loss=F.smooth_l1_loss((prediction-mean)/std,(batch['geometry']-mean)/std,beta=.5);loss.backward();torch.nn.utils.clip_grad_norm_(model.head.parameters(),5);optimizer.step();losses.append(float(loss.detach()))
        predicted,target=predict(model,validation);metrics=errors_for(predicted,target);selection=score(metrics);curve.append({'epoch':epoch,'loss':round(float(np.mean(losses)),6),'worstNormalized':round(selection[0],4),'meanNormalized':round(selection[1],4)})
        print(f'Epoch {epoch}/18 loss={np.mean(losses):.5f} worst={selection[0]:.3f} mean={selection[1]:.3f}',flush=True)
        if selection<best:best=selection;best_epoch=epoch;torch.save({'stateDict':model.state_dict(),'targetNames':NAMES,'architecture':'MobileNet39DirectGeometry-v1'},model_tmp)
    best_payload=torch.load(model_tmp,map_location='cpu',weights_only=True);model.load_state_dict(best_payload['stateDict'])
    validation_pred,validation_target=predict(model,validation);holdout_pred,holdout_target=predict(model,GeometryDataset(holdout_records,False));validation_metrics=errors_for(validation_pred,validation_target);holdout_metrics=errors_for(holdout_pred,holdout_target)
    metric_gates={name:(metric['absoluteError']['median']<=(3 if metric['unit']=='degrees' else .03) and metric['absoluteError']['p95']<=(8 if metric['unit']=='degrees' else .08)) for name,metric in holdout_metrics.items()}
    passes=sum(metric_gates.values())>=7 and all(metric_gates[name] for name in ['eLineUpper','eLineLower','verticalMidface','verticalLowerFace'])
    model_path.parent.mkdir(parents=True,exist_ok=True);model_path.write_bytes(model_tmp.read_bytes())
    result={'testedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policyVersion':'HEADUP-MENPO39-DIRECT-GEOMETRY-1.1','source':{'profiles':len(records),'imagesRetained':False},'partition':{'train':len(train_records),'validation':len(validation_records),'holdout':len(holdout_records)},'model':{'architecture':'MobileNet39 final four blocks fine-tuned + spatial geometry head','bestEpoch':best_epoch,'sha256':sha256(model_path),'bytes':model_path.stat().st_size},'training':{'curve':curve,'backboneUnfrozenFromEpoch':5,'backboneLearningRate':2e-5,'seconds':round(time.perf_counter()-started,2)},'validation':{'metrics':validation_metrics},'holdout':{'metrics':holdout_metrics},'metricGates':metric_gates,'passedMetricCount':sum(metric_gates.values()),'totalMetricComponents':len(metric_gates),'passesCandidatePromotionGate':passes,'retention':{'imagesRetained':False,'individualPredictionsRetained':False}}
    result_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps({'model':result['model'],'holdout':holdout_metrics,'passed':sum(metric_gates.values()),'promotion':passes},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
