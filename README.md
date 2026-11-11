# dsh-cookie-janitor

按可配置的天数清空 dsh-desktop 的 `Cookies` 与 `Cookies-journal`，让登录态按时失效；也可以随时手动触发一次。

## 为什么不是"直接删"

DSH 运行期间，桌面外壳（Electron/Chromium）会独占打开 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`，普通 `unlink` 必然返回 `EBUSY`。所以清理走延期：

```
到期 / 手动触发
   ├─ 当场删得掉（外壳没占着库） → 立刻清零，记 lastRunAt
   └─ 删不掉（常态）              → 写待清理标记，下次启动时清零
```

下次启动时插件最先执行：读到待清理标记就删库，记 `boot: pending clean applied`，新窗口从第 1 条 cookie 开始算。这是唯一可靠的时间窗——插件 `apply` 早于外壳打开 cookie 库。

## 手动清理

在会话输入框里直接敲斜杠命令，不经过模型，点回车即执行：

| 命令 | 作用 |
| --- | --- |
| `/clean-cookies` | 立即清理一次；删不掉时自动安排到下次启动清零 |
| `/clean-cookies-cancel` | 取消已安排的延期清理，之后的启动不再清空 |
| `/clean-cookies-status` | 查看目标目录、间隔天数、上次成功清理时间、有无待清理标记 |

同样能力也以工具形式暴露给模型：`cookie_janitor_run`、`cookie_janitor_cancel`、`cookie_janitor_status`。命令与工具共用同一份实现。

## 行为要点

启动时先消费待清理标记，再看距上次成功清理是否已过 `intervalDays`：超了就补一次，没超就按剩余时间挂一次性 `ctx.timeout`。清理锚点持久化，频繁重启不会把到期日一直往后推。

只对 Chrome cookie 库的几个文件名生效（`Cookies`、`Cookies-journal`、`Cookies-wal`、`Cookies-shm`），同目录其它文件绝不触碰。文件名必须是纯名称，`../` 之类的越界写法会被拒绝。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖同名行：

```yaml
- id: cookie-janitor
  name: dsh-cookie-janitor
  config:
    intervalDays: 7                  # 间隔天数
    directory: ''                    # 留空用 %APPDATA%\@deepseek-ai\dsh-desktop\Network
    files: [Cookies, Cookies-journal] # 只接受 Chrome cookie 库的文件名
    runOnStart: true                 # 启动时若已超期就补清
    contentOnly: false               # true = 只截断内容、保留文件
```

`intervalDays` 小于 0.001 会在加载期被拒。

## 安装

```
dsh plugin --profile desktop add ./dsh-cookie-janitor
```

## 验证是否真的成功

敲 `/clean-cookies`，若提示「已安排：下次进入 DSH 时清零」，说明文件正被占用——这是常态。随后完整退出 DSH（确认 `DeepSeek Harness.exe` 全部结束），再启动。插件会在启动窗口内删除 cookie 库并记 `boot: pending clean applied`，随后的窗口要求重新登录。

状态文件在 `~/.dsh/cookie-janitor/`：`state.json` 记上次成功清理时间，`pending-clean.json` 是待清理标记。

## 实现说明

零外部依赖：配置校验手写 Standard Schema（`~standard.validate`），不引 `@deepseek-ai/schemastery`。插件以 `link:` 方式装进 profile 后从工作区路径解析不到 profile 内的包，只依赖 Node 内置模块才不会在装上后 import 失败。

## License

MIT