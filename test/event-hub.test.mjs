/**
 * dsh-plugin-kit 离线测试：共享事件推送枢纽（ensureHostHub + 客户端总线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const Kit = (await import('../src/index.js')).default ?? (await import('../src/index.js'))

function makeCtx(opts = {}) {
  const provided = {}
  const routes = []
  return {
    provided,
    routes,
    provide: (name, value) => { provided[name] = value },
    get: (name) => provided[name],
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => (opts.rejectWith != null ? opts.rejectWith : undefined) },
    effect: (fn) => fn(),
  }
}

function sseReqRes() {
  const writes = []
  let code = null
  const res = {
    writeHead: (c) => { code = c },
    write: (chunk) => { writes.push(chunk) },
    end: () => {},
    on: () => {},
    status: () => code,
  }
  const req = {
    method: 'GET',
    url: '/dsh-event-hub/api/stream',
    on: (ev, cb) => { if (ev === 'close') setImmediate(cb) },
  }
  return { req, res, writes }
}

test('ensureHostHub：首个调用注册唯一路由+服务，后续调用复用单例', () => {
  const ctx = makeCtx()
  const a = Kit.ensureHostHub(ctx, { webServer: ctx.webServer, connection: ctx.connection })
  const b = Kit.ensureHostHub(ctx, { webServer: ctx.webServer, connection: ctx.connection })
  assert.equal(a, b, '同一 ctx 协调出单例')
  assert.equal(ctx.routes.length, 1, '只注册一条 SSE 路由')
  assert.equal(ctx.provided['dsh-event-hub'], a, '服务已 provide')
  assert.equal(Kit.EVENT_HUB_ROUTE, '/dsh-event-hub/api/stream')
})

test('publish → SSE 订阅者按序收到 {seq, plugin, data} 帧', () => {
  const ctx = makeCtx()
  const hub = Kit.ensureHostHub(ctx, { webServer: ctx.webServer, connection: ctx.connection })
  const { req, res, writes } = sseReqRes()
  const handled = ctx.routes[0].handler(req, res)
  if (handled && typeof handled.catch === 'function') handled.catch(() => {})

  hub.publish('dsh-fireworks', { category: 'turn', magnitude: 0.5 })
  hub.publish('dsh-kite', { activity: 0.8 })

  const frames = writes.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].plugin, 'dsh-fireworks')
  assert.deepEqual(frames[0].data, { category: 'turn', magnitude: 0.5 })
  assert.equal(frames[1].plugin, 'dsh-kite')
  assert.ok(frames[1].seq > frames[0].seq, 'seq 单调递增')
  assert.equal(hub.subscriberCount(), 1)
})

test('信任栅栏：requestRejection 有值时以该状态码拒绝且不写流', () => {
  const ctx = makeCtx({ rejectWith: 401 })
  const hub = Kit.ensureHostHub(ctx, { webServer: ctx.webServer, connection: ctx.connection })
  const { req, res, writes } = sseReqRes()
  const handled = ctx.routes[0].handler(req, res)
  if (handled && typeof handled.catch === 'function') handled.catch(() => {})
  assert.equal(res.status(), 401)
  assert.equal(writes.length, 0, '拒绝时不写任何流数据')
  assert.equal(hub.subscriberCount(), 0, '被拒请求不进入订阅集')
})

test('无 webServer 时返回 null 而不抛错（独立降级）', () => {
  const ctx = makeCtx({ webServerFail: true })
  assert.equal(Kit.ensureHostHub(ctx, {}), null)
})

test('client/source.js 客户端总线：单连接、按插件名分发、可取消', () => {
  const listeners = []
  globalThis.window = {}
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 1; listeners.push(this) }
  }

  const source = readFileSync(fileURLToPath(new URL('../client/source.js', import.meta.url)), 'utf8')
  const factory = new Function(`${source}; return PluginKit;`)()
  assert.equal(typeof factory.connectEvents, 'function')
  assert.equal(typeof factory.ensureClientHub, 'function')

  const seen = []
  const off1 = factory.connectEvents('dsh-fireworks', (d) => seen.push(['fw', d]))
  const off2 = factory.connectEvents('dsh-kite', (d) => seen.push(['kite', d]))
  assert.equal(listeners.length, 1, '两个消费者只创建一条 EventSource')
  assert.equal(listeners[0].url, '/dsh-event-hub/api/stream')

  const dispatch = (frame) => listeners[0].onmessage({ data: JSON.stringify(frame) })
  dispatch({ seq: 1, plugin: 'dsh-fireworks', data: { category: 'turn' } })
  dispatch({ seq: 2, plugin: 'dsh-kite', data: { activity: 0.9 } })
  dispatch({ seq: 3, plugin: 'dsh-other', data: { x: 1 } })
  assert.deepEqual(seen, [['fw', { category: 'turn' }], ['kite', { activity: 0.9 }]])

  off1()
  dispatch({ seq: 4, plugin: 'dsh-fireworks', data: { category: 'tool' } })
  assert.equal(seen.filter((s) => s[0] === 'fw').length, 1, '取消订阅后不再收到')
  off2()

  delete globalThis.window.__dshEventHub
  delete globalThis.EventSource
})
