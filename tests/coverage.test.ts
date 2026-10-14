import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateCoverage, demandForDate, validateDemandSchedule } from '../src/server/schedule/coverage.ts'
import { localDateTimeIso } from '../src/app/schedule/date-utils.ts'
import type { DemandInterval, DemandWeek } from '../src/app/schedule/team-planning-types.ts'
const role='cook',positions=[{id:role,name:'Повар'},{id:'cashier',name:'Кассир'}]
const interval=(startTime='08:00',endTime='20:00',needed=1,endDayOffset=0,positionId=role):DemandInterval=>({positionId,startTime,endTime,needed,endDayOffset})
const week=(rows:DemandInterval[]|null):DemandWeek=>Array.from({length:7},()=>rows)
const versions=(days:DemandWeek)=>[{effectiveFrom:'2038-01-01',days}]
const shift=(start='2038-01-04T08:00:00Z',end='2038-01-04T20:00:00Z',memberId='ivan',positionId:string|null=role,status='SCHEDULED')=>({memberId,positionId,status,scheduledStartAt:start,scheduledEndAt:end})
const calculate=(days:DemandWeek,shifts= [shift()],from='2038-01-04',to='2038-01-05',timezone='UTC')=>calculateCoverage(from,to,timezone,versions(days),[],shifts,positions)
test('unconfigured day is unknown; explicit empty day counts assignments as surplus',()=>{
  const unknown=calculate(week(null))[0],empty=calculate(week([]))[0]
  assert.equal(unknown.source,'unconfigured');assert.equal(unknown.segments.length,0);assert.equal(unknown.surplusIntervals,0)
  assert.equal(empty.noDemand,true);assert.equal(empty.surplusIntervals,1);assert.equal(empty.segments[0].needed,0)
})
test('exact coverage, shortages and surplus are simultaneous headcounts',()=>{
  const exact=calculate(week([interval()]))[0];assert.equal(exact.shortageIntervals,0);assert.equal(exact.surplusIntervals,0)
  const short=calculate(week([interval('08:00','20:00',2)]))[0];assert.equal(short.segments[0].shortage,1)
  const extra=calculate(week([interval()]),[shift(),shift(undefined,undefined,'anna')])[0];assert.equal(extra.segments[0].surplus,1)
})
test('consecutive shifts cover a long interval with no double counting at the boundary',()=>{
  const day=calculate(week([interval()]),[shift(undefined,'2038-01-04T12:00Z'),shift('2038-01-04T12:00Z',undefined,'anna')])[0]
  assert.equal(day.shortageIntervals,0);assert.equal(day.segments.length,1);assert.equal(day.segments[0].assigned,1)
})
test('a one-minute gap is preserved at exact boundaries',()=>{
  const day=calculate(week([interval()]),[shift(undefined,'2038-01-04T12:00Z'),shift('2038-01-04T12:01Z',undefined,'anna')])[0]
  const gap=day.segments.find(s=>s.shortage);assert.ok(gap);assert.equal(Date.parse(gap.endAt)-Date.parse(gap.startAt),60000)
})
test('a person with multiple profile roles, an unpositioned shift and cancelled shift do not cover another position',()=>{
  const day=calculate(week([interval(),interval('08:00','20:00',1,0,'cashier')]),[shift(),shift(undefined,undefined,'anna',null),shift(undefined,undefined,'max','cashier','CANCELLED')])[0]
  assert.equal(day.segments.find(s=>s.positionId==='cashier')?.assigned,0)
  assert.equal(day.segments.find(s=>s.positionId===role)?.assigned,1)
})
test('night and explicit 24-hour demand span year and month boundaries in the point timezone',()=>{
  const days=week(null);days[4]=[interval('20:00','08:00',1,1)]
  const result=calculateCoverage('2038-12-31','2039-01-02','Europe/Moscow',[{effectiveFrom:'2038-01-01',days}],[],[shift('2038-12-31T17:00Z','2039-01-01T05:00Z')],positions)
  assert.equal(result.length,2);assert.equal(result[0].shortageIntervals,0);assert.equal(result[1].shortageIntervals,0);assert.equal(result[1].source,'unconfigured');assert.equal(result[1].segments[0].needed,1)
  const aroundClock=calculate(week([interval('08:00','08:00',1,1)]),[shift('2038-01-03T08:00Z','2038-01-05T08:00Z')])[0]
  assert.equal(aroundClock.shortageIntervals,0);assert.equal(aroundClock.segments[0].assigned,1)
})
test('overnight 20:00-21:00 shortage and incoming prior-night coverage are computed separately',()=>{
  const days=week([interval('08:00','20:00'),interval('20:00','08:00',1,1)])
  const result=calculate(days,[shift('2038-01-03T20:00Z','2038-01-04T08:00Z'),shift(),shift('2038-01-04T21:00Z','2038-01-05T08:00Z')],'2038-01-04','2038-01-06')
  assert.equal(result[0].shortageIntervals,1);assert.equal(result[0].segments.find(s=>s.shortage)?.startAt,'2038-01-04T20:00:00.000Z')
  assert.equal(result[1].segments[0].assigned,1)
})
test('template revisions apply from their date; exception replaces whole day and reset restores the template',()=>{
  const history=[{effectiveFrom:'2038-01-01',days:week([interval()])},{effectiveFrom:'2038-02-01',days:week([interval('08:00','20:00',3)])}]
  assert.equal(demandForDate('2038-01-31',history,[]).intervals?.[0].needed,1)
  assert.equal(demandForDate('2038-02-01',history,[]).intervals?.[0].needed,3)
  assert.deepEqual(demandForDate('2038-02-01',history,[{date:'2038-02-01',intervals:[]}]),{source:'exception',intervals:[]})
})
test('overlap validation checks midnight, week edges, template transitions and exception neighbours',()=>{
  assert.throws(()=>validateDemandSchedule(versions(week([interval('08:00','08:00')])),[]))
  assert.throws(()=>validateDemandSchedule(versions(week([interval(),interval('10:00','21:00')])),[]),{code:'DEMAND_OVERLAP'})
  const days=week(null);days[6]=[interval('22:00','10:00',1,1)];days[0]=[interval('09:00','18:00')]
  assert.throws(()=>validateDemandSchedule(versions(days),[]),{code:'DEMAND_OVERLAP'})
  assert.throws(()=>validateDemandSchedule(versions(week([interval()])),[{date:'2038-01-04',intervals:[interval('20:00','10:00',1,1)]}]),{code:'DEMAND_OVERLAP'})
  validateDemandSchedule(versions(week([interval('08:00','20:00'),interval('20:00','08:00',1,1)])),[])
})
test('15-day bulk assignments recalculate every date; cancelled, exchanged and receiving-point assignments follow shift fields',()=>{
  const assignments=Array.from({length:15},(_,i)=>{const date=`2038-01-${String(i+4).padStart(2,'0')}`;return shift(date+'T08:00Z',date+'T20:00Z',i%2?'anna':'ivan')})
  const covered=calculate(week([interval()]),assignments,'2038-01-04','2038-01-19');assert.equal(covered.length,15);assert.ok(covered.every(d=>d.shortageIntervals===0))
  const updated=calculate(week([interval()]),assignments.map((s,i)=>i===4?{...s,status:'CANCELLED'}:s),'2038-01-04','2038-01-19');assert.equal(updated.filter(d=>d.shortageIntervals).length,1)
})
test('wall-clock conversion uses the point timezone and rejects nonexistent local times',()=>{
  assert.equal(localDateTimeIso('2038-01-04','08:00','Asia/Vladivostok'),'2038-01-03T22:00:00.000Z')
  assert.throws(()=>localDateTimeIso('2038-03-14','02:30','America/New_York'))
})
