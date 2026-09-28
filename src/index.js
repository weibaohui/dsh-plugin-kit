'use strict'

/**
 * @weibaohui/dsh-plugin-kit — host half.
 *
 * createShareRunJob：把一段提示词交给一个真实 agent 会话执行（分享/提交类
 * 动作的通用执行器）。优先使用同进程 agents 服务（输出流式可见）；服务缺失
 * 的组合降级为 headless spawn（`<binary> --profile headless <prompt>`，cwd
 * 为目标目录）。30 分钟超时 + 输出尾部截断，job 状态由调用方轮询。
 */

const { spawn } = require('node:child_process')

const SHARE_RUN_TIMEOUT_MS = 30 * 60 * 1000
const SHARE_RUN_OUTPUT_CAP = 256 * 1024

function createShareRunJob({ binary = 'dsh', prompt, dir, jobs, logger, services }) {
  const id = 'sr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const job = { id, status: 'running', startedAt: new Date().toISOString(), dir, promptHead: String(prompt || '').slice(0, 80), output: '', code: null }
  jobs.set(id, job)
  if (services && services.agents && services.agentDefaultModel) {
    runShareInProcess(services, { prompt, dir, job, logger })
      .catch(e => { job.status = 'error'; job.output = (job.output + '\n' + String(e && e.message)).slice(-SHARE_RUN_OUTPUT_CAP) })
    return job
  }
  let child
  try {
    child = spawn(binary, ['--profile', 'headless', prompt], { cwd: dir })
  } catch (e) {
    job.status = 'error'
    job.output = String(e && e.message)
    return job
  }
  const append = (chunk) => {
    job.output = (job.output + String(chunk)).slice(-SHARE_RUN_OUTPUT_CAP)
  }
  child.stdout && child.stdout.on('data', append)
  child.stderr && child.stderr.on('data', append)
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL') } catch {}
    job.status = 'error'
    job.output += '\n[killed: timeout]'
  }, SHARE_RUN_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  child.on('error', (e) => { clearTimeout(timer); job.status = 'error'; append('\n' + String(e && e.message)) })
  child.on('close', (code) => {
    clearTimeout(timer)
    job.status = code === 0 ? 'done' : 'failed'
    job.code = code
    logger.info && logger.info(`dsh-plugin-kit: share run ${id} ${job.status} (code ${code})`)
  })
  return job
}

async function runShareInProcess(services, { prompt, dir, job, logger }) {
  const { randomUUID } = await import('node:crypto')
  const selection = services.agentDefaultModel.currentSelection()
  const sessionId = 'session-' + randomUUID()
  job.sessionId = sessionId
  const { agent } = await services.agents.create({
    sessionId,
    // 标准预设：不带显式选择会继承用户默认（如 Solo Thinking 只有 thinking/notify
    // 工具），读文件/调 API 都做不了
    meta: { cwd: dir, agentPreset: 'standard' },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const seen = new Set()
  const liveLine = (text) => {
    job.output = (job.output + text).slice(-SHARE_RUN_OUTPUT_CAP)
  }
  // 事件数组防御性取用：spill/裁剪策略下形状可能变化，绝不让 pump 抛错拖垮任务。
  // dsh 0.1.2-rc.1 把会话事件数组从 session.events 改名为 session.log——log 优先、
  // events 兜底，兼容新旧宿主（缺失时 pump 与兜底提取都拿不到输出）。
  const eventList = () => {
    try {
      const s = agent.session
      if (Array.isArray(s.log)) return s.log
      if (Array.isArray(s.events)) return s.events
      return []
    } catch { return [] }
  }
  const pump = () => {
    for (const ev of eventList()) {
      if (ev.seq < firstSeq || seen.has(ev.seq)) continue
      seen.add(ev.seq)
      const d = ev.data || {}
      // 流式文本：text-delta 增量（block-assembler 形状）；'text' 整块为旧形状兜底。
      // reasoning-delta 刻意不进输出（输出=可见回答，不含思考流）。
      if (ev.type === 'assistant/chunk' && d.chunk && typeof d.chunk.text === 'string' && (d.chunk.type === 'text-delta' || d.chunk.type === 'text')) {
        liveLine(d.chunk.text)
      } else if (ev.type === 'tool/call') {
        liveLine('\n[tool] ' + String(d.name || '') + ' ')
      }
    }
  }
  const timer = setInterval(pump, 300)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    await agent.whenIdle()
  } finally {
    clearInterval(timer)
    pump()
  }
  // 兜底：流式全程未捕获到文本时（事件形状漂移、spill 裁剪等），从最终 assistant
  // 消息的 content 块提取可见文本全文——宁可慢一次拼接，也不交回空输出
  if (String(job.output).trim() === '') {
    try {
      const list = eventList()
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const ev = list[i]
        const msg = ev && ev.type === 'assistant/message' && ev.data ? ev.data.message : undefined
        if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b) => b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
          if (text.trim() !== '') { job.output = text.slice(-SHARE_RUN_OUTPUT_CAP); break }
        }
      }
    } catch { /* 兜底失败保持原样 */ }
  }
  try { await services.sessions.flush(agent.session) } catch {}
  job.status = 'done'
  logger.info && logger.info(`dsh-plugin-kit: share run ${job.id} done`)
}

// ── 共享事件推送枢纽（宿主侧）──────────────────────────────────────────
// 解决：dsh web 网关是 HTTP/1.1，同源并发只有 ~6 条连接，每个插件自建
// 永久 SSE 会把预算占满、首页全部排队。第一个调用 ensureHostHub 的插件
// 成为「宿主」：注册唯一的共享事件 SSE 路由并 provide 服务；后续调用者
// 经 ctx.get 拿到现成服务直接用。客户端 counterpart 见 client/source.js
// 的 PluginKit.connectEvents / ensureClientHub。
const EVENT_HUB_ROUTE = '/dsh-event-hub/api/stream'
const EVENT_HUB_SERVICE = 'dsh-event-hub'

/**
 * 取得（或创建）进程内唯一的枢纽服务。
 * @param ctx cordis 插件上下文（用于 provide/get）
 * @param opts { webServer, connection } 消费插件自己 inject 的服务
 * @returns { publish(plugin, data), subscriberCount(), dispose() } 或 null
 */
function ensureHostHub(ctx, opts) {
  const o = opts || {}
  const existing = typeof ctx.get === 'function' ? ctx.get(EVENT_HUB_SERVICE) : null
  if (existing && typeof existing.publish === 'function') return existing
  if (!o.webServer || !o.connection) return null

  const subscribers = new Set()
  let seq = 0
  const service = {
    publish(plugin, data) {
      seq += 1
      const frame = { seq, plugin, data }
      const text = `data: ${JSON.stringify(frame)}\n\n`
      for (const res of subscribers) {
        try { res.write(text) } catch { subscribers.delete(res) }
      }
      return seq
    },
    subscriberCount: () => subscribers.size,
  }
  try { ctx.provide(EVENT_HUB_SERVICE, service) } catch { /* 已被并发提供：沿用 get 结果 */ }

  try {
    const disposeRoute = o.webServer.register({
      kind: 'prefix',
      path: '/dsh-event-hub/api',
      handler: async (req, res) => {
        const rejection = typeof o.connection.requestRejection === 'function'
          ? o.connection.requestRejection(req)
          : undefined
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end()
          return
        }
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          if (req.method === 'GET' && url.pathname.replace(/\/+$/, '').endsWith(EVENT_HUB_ROUTE)) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            res.write('retry: 3000\n\n')
            subscribers.add(res)
            const heartbeat = setInterval(() => {
              try { res.write(': ping\n\n') } catch { clearInterval(heartbeat) }
            }, 25000)
            req.on('close', () => {
              clearInterval(heartbeat)
              subscribers.delete(res)
            })
            return
          }
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }))
        } catch (e) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: (e && e.message) || 'internal error' }))
          } catch { /* res 可能已部分写出 */ }
        }
      },
    })
    // 路由注销与订阅清场由调用方在自身 effect 清理里触发
    service.dispose = () => {
      try { if (typeof disposeRoute === 'function') disposeRoute() } catch {}
      for (const res of subscribers) { try { res.end() } catch {} }
      subscribers.clear()
    }
  } catch { /* webServer 不可用：服务仍可 provide，仅无 HTTP 通道 */ }
  return service
}

module.exports = { createShareRunJob, runShareInProcess, SHARE_RUN_TIMEOUT_MS, SHARE_RUN_OUTPUT_CAP, ensureHostHub, EVENT_HUB_ROUTE, EVENT_HUB_SERVICE }
