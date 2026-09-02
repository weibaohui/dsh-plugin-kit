/**
 * @weibaohui/dsh-plugin-kit — client source（由消费者构建脚本内联进 bundle，
 * 不经 loader 运行时加载）。对外暴露 PluginKit：
 *
 *   PluginKit.substituteParams(template, params)   — {{key}} 模板插值
 *   PluginKit.makeActionShareDialog(React, opts)   — 返回 ActionShareDialog 组件
 *
 * ActionShareDialog props：
 *   title / hint / rows: [[label, value], ...] / initialPrompt
 *   run: async (prompt) => { jobId }      — 发起执行
 *   poll: async (jobId) => { status, output, code }
 *   labels: { copy, copied, run, running, done, failed, outputLabel, close }
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
    var doFetch = options.fetch || (typeof fetch !== 'undefined' ? fetch : null)
    var inputStyle = { width: '100%', minHeight: 190, resize: 'vertical', fontFamily: 'var(--dsw-font-family)', lineHeight: 1.6, fontSize: 12, background: 'var(--dsw-alias-bg-layer-2,transparent)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '8px', padding: '10px', boxSizing: 'border-box' }
    var btnStyle = { background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '8px', padding: '5px 12px', fontSize: 13, cursor: 'pointer', font: 'inherit' }
    var primaryStyle = Object.assign({}, btnStyle, { background: 'var(--dsw-alias-brand-primary,#4a7dff)', borderColor: 'var(--dsw-alias-brand-primary,#4a7dff)', color: '#fff' })

    return function ActionShareDialog(props) {
      var labels = props.labels || {}
      var _p = useState(props.initialPrompt || '')
      var prompt = _p[0]; var setPrompt = _p[1]
      var _j = useState(null)
      var job = _j[0]; var setJob = _j[1]
      var _b = useState(false)
      var busy = _b[0]; var setBusy = _b[1]
      var _c = useState(false)
      var copied = _c[0]; var setCopied = _c[1]
      var _e = useState('')
      var error = _e[0]; var setError = _e[1]

      useEffect(function () {
        if (job === null || job.status !== 'running' || typeof props.poll !== 'function') return
        var timer = setInterval(function () {
          props.poll(job.jobId).then(function (d) {
            setJob({ jobId: job.jobId, status: d.status, output: d.output || '', code: d.code !== undefined ? d.code : null, sessionId: d.sessionId })
          }).catch(function () {})
        }, 1500)
        return function () { clearInterval(timer) }
      }, [job !== null && job.jobId])

      var doRun = function () {
        if (typeof props.run !== 'function') return
        setBusy(true); setError('')
        props.run(prompt).then(function (r) {
          setJob({ jobId: r.jobId, status: 'running', output: '', code: null })
        }).catch(function (e) { setError(String(e && e.message)) }).finally(function () { setBusy(false) })
      }
      var copy = function () {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(prompt).then(function () { setCopied(true); setTimeout(function () { setCopied(false) }, 1500) }).catch(function () {})
        }
      }
      var statusText = job === null ? '' : job.status === 'running' ? (labels.running || 'running') : job.status === 'done' ? (labels.done || 'done') : (labels.failed || 'failed') + (job.code != null ? ' (' + job.code + ')' : '')

      return h('div', { onClick: function (e) { if (e.target === e.currentTarget && props.onClose) props.onClose() }, style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { style: { width: 'min(640px,92vw)', maxHeight: '86vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))', borderRadius: '16px', padding: '20px', display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary,inherit)', font: 'var(--dsw-font-family,inherit)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontSize: 17, fontWeight: 600 } }, title || ''),
            h('button', { onClick: props.onClose, style: Object.assign({}, btnStyle, { marginLeft: 'auto', width: 28, height: 28, padding: 0, borderRadius: 28 }) }, '✕')),
          hint ? h('div', { style: { fontSize: 12, opacity: .7 } }, hint) : null,
          (props.rows || []).length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 } },
            props.rows.map(function (r, i) {
              return r[1] ? h('div', { key: i }, h('b', null, r[0] + '：'), h('span', null, r[1])) : null
            })) : null,
          h('textarea', { value: prompt, onChange: function (e) { setPrompt(e.target.value) }, spellCheck: false, style: inputStyle }),
          error !== '' ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error,#c75050)' } }, error) : null,
          job !== null ? h('div', null,
            h('div', { style: { fontSize: 12, opacity: .7, margin: '4px 0' } }, (labels.outputLabel || 'Output') + ' · ' + statusText),
            h('pre', { style: { maxHeight: 220, margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--dsw-alias-bg-layer-2,transparent)', border: '1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))', borderRadius: '8px', padding: '8px' } }, job.output || '…')) : null,
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { onClick: copy, style: btnStyle }, copied ? (labels.copied || 'Copied') : (labels.copy || 'Copy')),
            h('button', { onClick: doRun, disabled: busy || (job !== null && job.status === 'running'), style: primaryStyle }, job !== null && job.status === 'running' ? (labels.running || 'Running…') : (labels.run || 'Run')))))
    }
  }

  return { substituteParams: substituteParams, makeActionShareDialog: makeActionShareDialog }
})()
