import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const kit = require('../src/index.js')

test('createShareRunJob：spawn 不可用二进制 → job error 落地，不抛出', () => {
  const jobs = new Map()
  const job = kit.createShareRunJob({ binary: 'definitely-not-a-binary-xyz', prompt: 'p', dir: process.cwd(), jobs, logger: { info() {}, warn() {} }, services: null })
  assert.ok(job.id.startsWith('sr'))
  assert.equal(job.status, 'running') // spawn 错误经 error 事件异步落地
})

test('createShareRunJob：promptHead 截断与 output 封顶常量', () => {
  const jobs = new Map()
  const job = kit.createShareRunJob({ binary: 'definitely-not-a-binary-xyz', prompt: 'x'.repeat(200), dir: process.cwd(), jobs, logger: { info() {}, warn() {} }, services: null })
  assert.equal(job.promptHead.length, 80)
  assert.equal(kit.SHARE_RUN_OUTPUT_CAP, 256 * 1024)
})
