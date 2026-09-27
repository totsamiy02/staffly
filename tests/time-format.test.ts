import assert from 'node:assert/strict'
import { it } from 'node:test'
import { formatTimeEntry } from '../src/component/ui/date-picker/time-format.ts'

it('formats compact and partial time entries without hiding invalid hours or minutes', () => {
  assert.equal(formatTimeEntry('2222'), '22:22')
  assert.equal(formatTimeEntry('930', true), '09:30')
  assert.equal(formatTimeEntry('9:3', true), '09:03')
  assert.equal(formatTimeEntry('9', true), '09:00')
  assert.equal(formatTimeEntry(''), '')
  assert.equal(formatTimeEntry('25:99', true), '25:99')
  assert.equal(formatTimeEntry('ab12cd34'), '12:34')
})
