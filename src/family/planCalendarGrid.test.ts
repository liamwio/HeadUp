import {it,expect} from 'vitest'
import {planMonth,moveMonth} from './planCalendarGrid'
import {defaultPlan} from './model'
import {archiveFixture} from './backupVolumes.fixture'
it('uses Monday-first leap-year grids and crosses a year without timezone shifts',()=>{const p={...defaultPlan('p'),enabled:true,nextDate:'2024-02-28',windowDays:3},days=planMonth('2024-02',p,[]);expect(days[0].date).toBe('2024-01-29');expect(days).toHaveLength(42);expect(days.filter(d=>d.planned).map(d=>d.date)).toEqual(['2024-02-28','2024-02-29','2024-03-01']);expect(moveMonth('2026-12',1)).toBe('2027-01');expect(moveMonth('2026-01',-1)).toBe('2025-12')})
it('shows only one logical record per revision chain and keeps record markers when a plan is paused',()=>{const a=archiveFixture(),p={...defaultPlan(a.profiles[0].id),nextDate:a.sessions[0].recordedOn};const days=planMonth(p.nextDate.slice(0,7),p,a.sessions);expect(days.find(d=>d.date===p.nextDate)?.records).toHaveLength(1);expect(days.some(d=>d.planned)).toBe(false)})
it('tolerates temporarily empty date input without inventing a planned window',()=>{const p={...defaultPlan('p'),enabled:true,nextDate:''};expect(planMonth('2026-09',p,[]).some(d=>d.planned)).toBe(false)})
