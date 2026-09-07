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
  // 事件数组防御性取用：spill/裁剪策略下形状可能变化，绝不让 pump 抛错拖垮任务
  const eventList = () => {
    try { return Array.isArray(agent.session.events) ? agent.session.events : [] } catch { return [] }
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

module.exports = { createShareRunJob, runShareInProcess, SHARE_RUN_TIMEOUT_MS, SHARE_RUN_OUTPUT_CAP }
