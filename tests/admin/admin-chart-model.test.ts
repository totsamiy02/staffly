import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chartGaps,chartSeries,chartScale } from '../../src/features/admin/admin-chart-model.ts'
const at=(i:number)=>new Date(Date.UTC(2026,10,8,0,i*5)).toISOString(),range={from:at(0),to:at(6),stepMs:300000}
test('small observed counts and zeros remain connected even in partial intervals',()=>{
 const rows=[{at:at(0),users:0},{at:at(1),users:0,incomplete:true},{at:at(2),users:1,incomplete:true},{at:at(3),users:0}]
 const result=chartSeries(rows,'users',range.stepMs)
 assert.deepEqual(result.bridges,[]);assert.deepEqual(result.parts,[{indices:[0,1,2,3],partial:true}]);assert.deepEqual(chartGaps(rows,['users'],range),[])
})
test('missing collection is represented separately and does not become an invented zero',()=>{
 const rows=[{at:at(0),users:0},{at:at(1),users:1},{at:at(2),users:null},{at:at(3),users:null},{at:at(4),users:0}]
 const result=chartSeries(rows,'users',range.stepMs)
 assert.deepEqual(result.bridges,[[1,4]]);assert.equal(rows[2].users,null)
 assert.deepEqual(chartGaps(rows,['users'],range),[{from:Date.parse(at(1))+150000,to:Date.parse(at(3))+150000}])
})
test('chart axis fits small counters instead of reserving a fixed 0–3 range',()=>{
 assert.deepEqual(chartScale([0,0]),{max:1,ticks:[0,1]})
 assert.deepEqual(chartScale([0,1]),{max:1,ticks:[0,1]})
 assert.deepEqual(chartScale([0,1,2]),{max:2,ticks:[0,1,2]})
 for(const peak of [3,7,12,87,319,1400,47892]){
  const scale=chartScale([0,peak]);assert(scale.max>=peak);assert(scale.max<=peak*2);assert(scale.ticks.every(Number.isInteger));assert(new Set(scale.ticks).size===scale.ticks.length)
 }
})
test('chart axis supports fractional measurements and adapts tick density',()=>{
 assert.equal(chartScale([.1,.4]).max,.4)
 assert(chartScale([0,10],3).ticks.length<=chartScale([0,10],5).ticks.length)
 assert.deepEqual(chartScale([NaN,Infinity]),{max:1,ticks:[0,1]})
})
