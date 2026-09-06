/**
 * @weibaohui/dsh-plugin-kit — client source（由消费者构建脚本内联进 bundle，
 * 不经 loader 运行时加载）。对外暴露 PluginKit：
 *
 *   PluginKit.substituteParams(template, params)   — {{key}} 模板插值
 *   PluginKit.makeActionShareDialog(React, opts)   — 返回 ActionShareDialog 组件
 *
 * ActionShareDialog props：
 *   title / hint / rows: [[label, value], ...] / initialPrompt
 *   params: [{ key, label?, placeholder?, multiline?, value? }]  — 可选；模板参数
 *     输入区（idle 态渲染在 prompt 上方），值实时替换进 prompt 的 {{key}} 占位符
 *   completedView: ({ job, output, close, retry }) => node  — 可选；完成态插槽，
 *     提供后 job done 不再渲染默认「输出原文」，改由插槽全权负责（如解析 AI 输出
 *     成可编辑表单 + 创建按钮），Dialog footer 同时置空，操作按钮由插槽自承
 *   run: async (prompt) => { jobId }      — 发起执行
 *   poll: async (jobId) => { status, output, code }
 *   labels: { copy, copied, run, running, done, failed, outputLabel, openSession, close }
 *   onOpenSession: (sessionId) => void                — 可选；job 出现 sessionId 时渲染「打开会话」
 *   onClose
 *
 * 全部样式内联（主题 token + 回退值），消费者无需自带 CSS。
 */
var PluginKit = (function () {
  function substituteParams(template, params) {
    var out = String(template || '')
    for (var key in (params || {})) out = out.split('{{' + key + '}}').join(String(params[key]))
    return out
  }

  function makeActionShareDialog(React, options) {
    options = options || {}
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var doFetch = options.fetch || (typeof fetch !== 'undefined' ? fetch : null)
    var inputStyle = { width: '100%', minHeight: 190, resize: 'vertical', fontFamily: 'var(--dsw-font-family)', lineHeight: 1.6, fontSize: 12, background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '8px', padding: '10px', boxSizing: 'border-box' }
    var paramStyle = { width: '100%', fontFamily: 'var(--dsw-font-family)', lineHeight: 1.5, fontSize: 13, background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '8px', padding: '6px 10px', boxSizing: 'border-box' }
    var btnStyle = { background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '8px', padding: '5px 12px', fontSize: 13, cursor: 'pointer', font: 'inherit' }
    // 主按钮亮暗跟随：与 skills-management .sk-btn-primary 同款 token 组合
    var primaryStyle = Object.assign({}, btnStyle, { background: 'var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4a7dff))', borderColor: 'transparent', color: 'var(--dsw-alias-label-primary-inverted,#fff)' })

    return function ActionShareDialog(props) {
      var title = props.title
      var hint = props.hint
      var labels = props.labels || {}
      // 模板参数定义（[{key,label,placeholder,multiline,value}]）→ 值表
      var paramDefs = Array.isArray(props.params) ? props.params : []
      var initialParamValues = {}
      for (var pi = 0; pi < paramDefs.length; pi++) {
        var def = paramDefs[pi]
        initialParamValues[def.key] = def.value !== undefined && def.value !== null ? String(def.value) : ''
      }
      var _pv = useState(initialParamValues)
      var paramValues = _pv[0]; var setParamValues = _pv[1]
      var _p = useState(props.initialPrompt || '')
      var prompt = _p[0]; var setPrompt = _p[1]
      // 「上次自动生成的 prompt」ref 镜像：effect 里比较当前 prompt 是否等于它，
      // 判断用户是否手动编辑过——未手改则参数/模板变化可安全覆盖，手改过则保留
      // 手动编辑（ntd ActionButton 的 lastGenerated 同款规则）。旧 dirty 单标记
      // 无法表达「手改后又想让参数替换生效」的场景，且要同时服务 initialPrompt
      // 异步到位的跟随行为，故统一收敛到这一处比较。
      var lastGeneratedRef = useRef(null)
      var _j = useState(null)
      var job = _j[0]; var setJob = _j[1]
      var _b = useState(false)
      var busy = _b[0]; var setBusy = _b[1]
      var _c = useState(false)
      var copied = _c[0]; var setCopied = _c[1]
      var _e = useState('')
      var error = _e[0]; var setError = _e[1]

      // 参数值/模板变化 → 重新生成 prompt；仅当用户未手改时覆盖
      useEffect(function () {
        var generated = substituteParams(props.initialPrompt || '', paramValues)
        var userEdited = lastGeneratedRef.current !== null && prompt !== lastGeneratedRef.current
        lastGeneratedRef.current = generated
        if (!userEdited) setPrompt(generated)
      }, [props.initialPrompt, paramValues])

      useEffect(function () {
        if (job === null || job.status !== 'running' || typeof props.poll !== 'function') return
        var timer = setInterval(function () {
          props.poll(job.jobId).then(function (d) {
            setJob({ jobId: job.jobId, status: d.status, output: d.output || '', code: d.code !== undefined ? d.code : null, sessionId: d.sessionId })
          }).catch(function () {})
        }, 1500)
        return function () { clearInterval(timer) }
      }, [job !== null && job.jobId])

      var setParam = function (key, value) {
        setParamValues(function (prev) {
          var next = {}
          for (var k in prev) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      var doRun = function () {
        if (typeof props.run !== 'function') return
        setBusy(true); setError('')
        props.run(prompt).then(function (r) {
          setJob({ jobId: r.jobId, status: 'running', output: '', code: null })
        }).catch(function (e) { setError(String(e && e.message)) }).finally(function () { setBusy(false) })
      }
      var canOpenSession = typeof props.onOpenSession === 'function' && job !== null && job.sessionId
      var openSession = function () { props.onOpenSession(job.sessionId) }
      var copy = function () {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(prompt).then(function () { setCopied(true); setTimeout(function () { setCopied(false) }, 1500) }).catch(function () {})
        }
      }
      var statusText = job === null ? '' : job.status === 'running' ? (labels.running || 'running') : job.status === 'done' ? (labels.done || 'done') : (labels.failed || 'failed') + (job.code != null ? ' (' + job.code + ')' : '')
      // 完成态插槽：提供后 job done 由插槽全权渲染（footer 置空，操作按钮插槽自承）
      var completedSlot = typeof props.completedView === 'function' && job !== null && job.status === 'done'

      return h('div', { onClick: function (e) { if (e.target === e.currentTarget && props.onClose) props.onClose() }, style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 'min(640px,92vw)', maxHeight: '86vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary,inherit)', font: 'var(--dsw-font-family,inherit)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontSize: 17, fontWeight: 600 } }, title || ''),
            h('button', { onClick: props.onClose, style: Object.assign({}, btnStyle, { marginLeft: 'auto', width: 28, height: 28, padding: 0, borderRadius: 28 }) }, '✕')),
          hint ? h('div', { style: { fontSize: 12, opacity: .7 } }, hint) : null,
          // 模板参数输入区（idle 态；值实时替换进 prompt，位于 prompt 上方与 ntd 同布局）
          paramDefs.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            paramDefs.map(function (d) {
              return h('label', { key: d.key, style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: .85 } },
                h('span', null, d.label || d.key),
                d.multiline
                  ? h('textarea', { value: paramValues[d.key] || '', placeholder: d.placeholder || '', onChange: function (e) { setParam(d.key, e.target.value) }, spellCheck: false, style: Object.assign({}, paramStyle, { minHeight: 64, resize: 'vertical' }) })
                  : h('input', { value: paramValues[d.key] || '', placeholder: d.placeholder || '', onChange: function (e) { setParam(d.key, e.target.value) }, style: paramStyle }))
            })) : null,
          (props.rows || []).length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 } },
            props.rows.map(function (r, i) {
              return r[1] ? h('div', { key: i }, h('b', null, r[0] + '：'), h('span', null, r[1])) : null
            })) : null,
          h('textarea', { value: prompt, onChange: function (e) { setPrompt(e.target.value) }, spellCheck: false, style: inputStyle }),
          error !== '' ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error,#c75050)' } }, error) : null,
          completedSlot
            ? props.completedView({ job: job, output: job.output || '', close: props.onClose, retry: doRun })
            : (job !== null ? h('div', null,
                h('div', { style: { fontSize: 12, opacity: .7, margin: '4px 0' } }, (labels.outputLabel || 'Output') + ' · ' + statusText),
                h('pre', { style: { maxHeight: 220, margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--dsw-alias-bg-layer-2,transparent)', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))', borderRadius: '8px', padding: '8px' } }, job.output || '…')) : null),
          completedSlot ? null : h('div', { style: { display: 'flex', gap: 8 } },
            canOpenSession ? h('button', { onClick: openSession, style: btnStyle }, labels.openSession || 'Open chat') : null,
            h('button', { onClick: copy, style: btnStyle }, copied ? (labels.copied || 'Copied') : (labels.copy || 'Copy')),
            h('button', { onClick: doRun, disabled: busy || (job !== null && job.status === 'running'), style: primaryStyle }, job !== null && job.status === 'running' ? (labels.running || 'Running…') : (labels.run || 'Run')))))
    }
  }

  return { substituteParams: substituteParams, makeActionShareDialog: makeActionShareDialog }
})()
