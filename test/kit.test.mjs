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

test('client 主按钮样式随主题翻转（state-business-primary + inverted 标签色，不硬编码白字）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/source.js', import.meta.url), 'utf8')
  assert.match(src, /background: 'var\(--dsw-alias-state-business-primary/)
  assert.match(src, /color: 'var\(--dsw-alias-label-primary-inverted/)
  assert.doesNotMatch(src, /color: '#fff'/)
})

test('ActionShareDialog 支持模板参数与完成态插槽（创建/生成态扩展，向后兼容分享态）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/source.js', import.meta.url), 'utf8')
  // params：可选模板参数区，{{key}} 实时替换，label/multiline 可配
  assert.match(src, /paramDefs = Array\.isArray\(props\.params\)/)
  assert.match(src, /initialParamValues\[def\.key\]/)
  assert.match(src, /d\.multiline/)
  // 脏跟踪：prompt !== lastGenerated 时参数变化不再覆盖（ntd lastGenerated 同款）
  assert.match(src, /lastGeneratedRef/)
  assert.match(src, /userEdited = lastGeneratedRef\.current !== null && prompt !== lastGeneratedRef\.current/)
  // completedView：done 态插槽接管渲染，footer 置空，ctx 携带 job/output/close/retry
  assert.match(src, /typeof props\.completedView === 'function' && job !== null && job\.status === 'done'/)
  assert.match(src, /props\.completedView\(\{ job: job, output: job\.output \|\| '', close: props\.onClose, retry: doRun \}\)/)
  assert.match(src, /completedSlot \? null : h\('div', \{ style: \{ display: 'flex', gap: 8 \} \}/)
})
