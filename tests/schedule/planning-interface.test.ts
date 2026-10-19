import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockBodyScroll } from '../../src/component/ui/body-scroll-lock.ts'
import { enqueueMessage } from '../../src/component/ui/toast/message-queue.ts'
import { buildDemandCycle, demandOnDate, monthDates, weekDates, coverageLabel } from '../../src/app/schedule/planning/planning-presentation.ts'
import type { DemandData, CoverageDay } from '../../src/app/schedule/planning/team-planning-types.ts'

test('overlapping dialogs release body scrolling in either unmount order',()=>{
  for(const order of [[0,1],[1,0]]) {
    const body={style:{overflow:'auto'}}
    const release=[lockBodyScroll(body),lockBodyScroll(body)]
    release[order[0]]();assert.equal(body.style.overflow,'hidden')
    release[order[1]]();assert.equal(body.style.overflow,'auto')
    release[order[0]]();assert.equal(body.style.overflow,'auto')
  }
})
test('one FIFO queue preserves bursts and refreshes a pending notice without moving it',()=>{
  let queue:Array<{id:string;message:string}>=[]
  for(const id of ['toast','shift-1','shift-2','shift-3'])queue=enqueueMessage(queue,{id,message:id})
  queue=enqueueMessage(queue,{id:'shift-1',message:'updated'})
  assert.deepEqual(queue.map(item=>item.id),['toast','shift-1','shift-2','shift-3'])
  assert.equal(queue[1].message,'updated')
})
test('date shortcuts select only that week or month, including year and leap-day boundaries',()=>{
  assert.deepEqual(weekDates('2026-12-31'),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03'])
  assert.equal(monthDates('2028-02').length,29)
  assert.equal(monthDates('2026-10').at(-1),'2026-10-31')
})
test('date editor distinguishes a saved exception, recurring template and missing plan',()=>{
  const data:DemandData={versions:[{id:'v',effectiveFrom:'2026-10-01',days:[[],null,null,null,null,null,null]}],exceptions:[{date:'2026-10-13',intervals:[]}]}
  assert.equal(demandOnDate(data,'2026-10-12').source,'template')
  assert.equal(demandOnDate(data,'2026-10-13').source,'exception')
  assert.equal(demandOnDate(data,'2026-10-14').source,'unconfigured')
  assert.equal(demandOnDate(data,'2026-09-30').source,'unconfigured')
})
test('calendar indicators describe staffing status rather than an unexplained interval count',()=>{
  const day:CoverageDay={date:'2026-10-13',source:'template',noDemand:false,segments:[],shortageIntervals:3,surplusIntervals:1}
  assert.equal(coverageLabel(day),'Нужны сотрудники')
  assert.equal(coverageLabel({...day,shortageIntervals:0}),'Работают сверх потребности')
  assert.equal(coverageLabel({...day,shortageIntervals:0,surplusIntervals:0,source:'unconfigured'}),'Потребность не задана')
})

test('a weekly cycle keeps all seven source days, past plans and one explicit day off',()=>{
  const interval={positionId:'cook',startTime:'09:00',endTime:'18:00',endDayOffset:0,needed:2}
  const data:DemandData={versions:[{id:'old',effectiveFrom:'2026-10-01',days:Array.from({length:7},()=>[interval])}],exceptions:[{date:'2026-10-12',intervals:[{...interval,needed:3}]},{date:'2026-10-13',intervals:[{...interval,needed:4}]}]}
  const cycle=buildDemandCycle(data,'2026-10-18','2026-10-14',{'2026-10-18':[]})
  assert.deepEqual(cycle.dates,['2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18'])
  assert.equal(cycle.effectiveFrom,'2026-10-14')
  assert.equal(cycle.days[0]![0].needed,3)
  assert.equal(cycle.days[1]![0].needed,4)
  assert.equal(cycle.days[5]![0].needed,2)
  assert.deepEqual(cycle.days[6],[])
  cycle.days[0]![0].needed=99
  assert.equal(data.exceptions[0].intervals[0].needed,3)
  assert.equal(buildDemandCycle(data,'2026-11-04','2026-10-14').effectiveFrom,'2026-11-02')
})
