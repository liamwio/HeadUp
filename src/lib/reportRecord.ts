import type {Mode} from '../types'
import {buildConsumerReport,type ConsumerReading} from './consumerReport'
import {frontReportCoverage} from './frontReportCoverage'
import {reportVersion} from '../data/report'
import type {ReportRecord} from './reportRecordValidation'
export {MAX_REPORT_BYTES,parseReportRecord} from './reportRecordValidation'
export type {ReportRecord} from './reportRecordValidation'
type Report=ReturnType<typeof buildConsumerReport>
export function reportFromRecord(record:ReportRecord):Report {
  const empty=buildConsumerReport([],false),front=record.measurements.filter(r=>r.view==='front'),profile=record.measurements.filter(r=>r.view==='profile')
  const lower=front.find(r=>r.code==='FRONT-RATIO-07'&&r.available),side=profile.find(r=>r.available)
  const issues=record.isExample?record.issues:[...new Set([...record.issues,...record.detection.front.issues.map(s=>`正面：${s}`),...record.detection.profile.issues.map(s=>`侧面：${s}`)])]
  return {...empty,createdAt:record.createdAt,isExample:record.isExample,front,profile,extended:record.extendedMeasurements,coverage:frontReportCoverage(front),frontDetection:record.detection.front,profileDetection:record.detection.profile,issues,
    measuredCount:record.measurements.filter(r=>r.available).length,
    summaries:record.summaries??[
      {label:'记录内容',value:`${front.filter(r=>r.available).length} 项正面读数`,note:'已打开此前下载的测量记录；文件不包含照片。'},
      {label:'正面比例',value:lower?`下半脸占比 ${lower.value}`:record.detection.front.title,note:lower?.note??'检测结果已按原记录保留。'},
      {label:'侧面测量',value:side?`${side.label} ${side.value}`:record.detection.profile.title,note:side?.note??'检测结果已按原记录保留。'},
    ]}
}
export function serializeReportRecord(report:Report,mode:Mode,version:typeof reportVersion|null=reportVersion):string {
  const clean=(rows:ConsumerReading[])=>rows.map(({score,...r})=>r)
  return JSON.stringify({schema:'headup-report-record-v2',createdAt:report.createdAt,isExample:report.isExample,mode,measurements:clean(report.front.concat(report.profile)),extendedMeasurements:clean(report.extended),summaries:report.summaries,detection:{front:report.frontDetection,profile:report.profileDetection},issues:report.issues,version},null,2)
}
