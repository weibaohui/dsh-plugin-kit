# @weibaohui/dsh-plugin-kit

[![npm version](https://img.shields.io/npm/v/@weibaohui/dsh-plugin-kit)](https://www.npmjs.com/package/@weibaohui/dsh-plugin-kit)

# @weibaohui/dsh-plugin-kit

[![npm version](https://img.shields.io/npm/v/@weibaohui/dsh-plugin-kit)](https://www.npmjs.com/package/@weibaohui/dsh-plugin-kit)

dsh 插件共享工具箱。把系列插件中重复的「AI 动作按钮」能力收拢为一处：

- **宿主**：`createShareRunJob` —— 把提示词交给真实 agent 会话执行（进程内 agents 服务优先流式，缺失降级 headless spawn；30 分钟超时 + 输出截断），任务状态由调用方轮询
- **client**：`PluginKit.ActionShareDialog` —— ntd ActionButton 同款交互（可编辑提示词 + 参数预览 + 复制 + 执行 + 实时输出），全内联样式，消费者无需自带 CSS

## 消费方式

```jsonc
// 插件 package.json（npm 源；dsh plugin add 时作为传递依赖一次性装上）
"dependencies": { "@weibaohui/dsh-plugin-kit": "^0.1.0" }
```

`dsh plugin add` 安装插件时作为传递依赖一次性装上。

### 宿主

```js
const { createShareRunJob } = require('@weibaohui/dsh-plugin-kit')
const job = createShareRunJob({ binary: 'dsh', prompt, dir, jobs: shareRunJobs, logger: ctx.logger, services: shareServices })
```

### client（构建期内联）

`client/index.js` 顶部声明，构建脚本把 `client/source.js` 内联进 bundle：

```js
const ShareDialog = PluginKit.makeActionShareDialog(__React)
// h(ShareDialog, { title, hint, rows, initialPrompt, run, poll, labels, onClose })
```

## 设计决策

- **构建期内联而非运行时插件**：kit 不进 profile 的 bundle 图，无降级逻辑；消费者构建时把 client 源码打进自己的 bundle，`dsh plugin add` 时宿主代码经 npm 传递依赖装齐——一次性装上，无挖坑
- **协议无关**：run/poll 以函数注入，提示词模板归各插件自有（业务层），kit 只收骨架
