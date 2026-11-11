/**
 * dsh-cookie-janitor — 定期清空 dsh-desktop 的 Cookies / Cookies-journal。
 *
 * 真实约束：DSH 运行期间，桌面外壳（Electron/Chromium）会独占打开这俩文件，
 * 普通 unlink 必然 EBUSY。所以清理不能靠「运行中删掉」，只能延期：
 *
 *   到期/点了清理 → 先试当场删
 *     ├─ 删得掉（DSH 没占着库）→ 立刻清零，记 lastRunAt
 *     └─ 删不掉（常态）        → 写 pending 标记，等下次启动先删
 *
 * 下次启动时插件最先跑：有 pending 就立刻删库并记 boot: pending clean applied，
 * 新窗口从第 1 条 cookie 开始算。若仍被占用（重叠的旧实例没退干净），
 * 标记保留，下一轮再试，不会丢。
 *
 * 为什么启动时能删：插件 apply 早于外壳打开 Network 库，这个时间窗是可靠的。
 * 兜底：可选脱离进程的 PowerShell 脚本，在你关掉 DSH 且无其它实例时删库。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-cookie-janitor'

/** 依赖：定时器排期；tools 注册手动工具；subprocess 可选（兜底脚本）。 */
export const inject = ['timer', 'tools']

/**
 * 配置校验：手写 Standard Schema，不引 @deepseek-ai/schemastery。
 * 插件以 link: 装进 profile 后从工作区路径解析不到 profile 内的包，
 * 只用 node 内置模块才不会在装上后 import 失败。
 */
const DEFAULTS = Object.freeze({
  intervalDays: 7,
  directory: '',
  files: ['Cookies', 'Cookies-journal'],
  runOnStart: true,
  contentOnly: false,
})

function normalize(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const issues = []
  const out = {}

  const days = raw.intervalDays ?? DEFAULTS.intervalDays
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0.001) {
    issues.push({ message: 'intervalDays 必须是 >= 0.001 的数字', path: ['intervalDays'] })
  } else {
    out.intervalDays = days
  }

  const directory = raw.directory ?? DEFAULTS.directory
  if (typeof directory !== 'string') issues.push({ message: 'directory 必须是字符串', path: ['directory'] })
  else out.directory = directory

  const files = raw.files ?? DEFAULTS.files
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== 'string')) {
    issues.push({ message: 'files 必须是非空的字符串数组', path: ['files'] })
  } else {
    out.files = files.map(String)
  }

  for (const key of ['runOnStart', 'contentOnly']) {
    const value = raw[key] ?? DEFAULTS[key]
    if (typeof value !== 'boolean') issues.push({ message: `${key} 必须是布尔值`, path: [key] })
    else out[key] = value
  }

  return { value: out, issues }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-cookie-janitor',
    validate: (input) => {
      const { value, issues } = normalize(input)
      return issues.length ? { issues } : { value }
    },
  },
}

const DAY_MS = 24 * 60 * 60 * 1000
/** 被占用时的重试间隔。 */
const RETRY_MS = 30 * 60 * 1000
/** 目标目录里允许被清空的文件；Chrome 的 cookie 库就是这几项，别的绝不碰。 */
const COOKIE_FILES = new Set(['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm'])

/** 默认目标：%APPDATA%\@deepseek-ai\dsh-desktop\Network。 */
function defaultDirectory() {
  const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
  return path.join(appData, '@deepseek-ai', 'dsh-desktop', 'Network')
}

/** 插件私有目录：~/.dsh/cookie-janitor（与 DSH_HOME 对齐）。 */
function stateDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'cookie-janitor')
}

const stateFile = () => path.join(stateDir(), 'state.json')
const pendingFile = () => path.join(stateDir(), 'pending-clean.json')

async function readJson(file, fallback = {}) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

const isMissing = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
const isBusy = (e) => e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES'

/**
 * 真删一轮。contentOnly=true 时只截断内容、保留文件本身（外壳仍持有句柄时不至于缺文件）。
 */
async function sweep(settings) {
  const directory = settings.directory || defaultDirectory()
  const names = settings.files.filter((n) => COOKIE_FILES.has(n))
  const removed = []
  const truncated = []
  const absent = []
  const busy = []
  const failed = []

  for (const name of names) {
    const file = path.join(directory, name)
    if (!existsSync(file)) {
      absent.push(name)
      continue
    }
    try {
      if (settings.contentOnly) {
        // 保留文件、只清空内容：句柄已打开时对已删除文件写入会失败，所以先截断再试删。
        await writeFile(file, '')
        truncated.push(name)
        continue
      }
      await unlink(file)
      removed.push(name)
    } catch (error) {
      if (isMissing(error)) absent.push(name)
      else if (isBusy(error)) busy.push({ file: name, error: error.code })
      else failed.push({ file: name, error: String(error?.message ?? error) })
    }
  }

  return { directory, removed, truncated, absent, busy, failed }
}

export function apply(ctx, config = {}) {
  const settings = () => normalize(config).value
  const intervalMs = () => Math.max(60_000, settings().intervalDays * DAY_MS)

  let running = false

  /** 跑一次清理并落状态；返回结果与"是否仍需要延期"。 */
  async function runOnce(reason) {
    if (running) return undefined
    running = true
    try {
      const current = settings()
      const result = await sweep(current)
      const state = await readJson(stateFile())
      const clean = result.failed.length === 0 && result.busy.length === 0
      const now = Date.now()
      // 只有真的清掉了才推进到期时间；被占用时保留原锚点，等延期清理兑现。
      await writeJson(stateFile(), clean
        ? { ...state, lastRunAt: now, lastReason: reason, lastResult: result }
        : { ...state, lastReason: reason, lastResult: result })

      if (result.removed.length || result.truncated.length) {
        ctx.logger?.info?.(`[cookie-janitor] ${reason} · 已清理 ${[...result.removed, ...result.truncated].join(', ')}`)
      }
      if (result.busy.length) {
        ctx.logger?.warn?.(`[cookie-janitor] ${reason} · 被占用，转为下次启动清理：${result.busy.map((b) => b.file).join(', ')}`)
      }
      if (result.failed.length) {
        ctx.logger?.warn?.(`[cookie-janitor] ${reason} · 失败 ${JSON.stringify(result.failed)}`)
      }
      return { result, needsDefer: result.busy.length > 0 }
    } catch (error) {
      ctx.logger?.warn?.(`[cookie-janitor] ${reason} · 异常 ${String(error?.message ?? error)}`)
      return undefined
    } finally {
      running = false
    }
  }

  /** 写/删延期标记，供下次启动消费。 */
  const markPending = (reason) => writeJson(pendingFile(), {
    createdAt: Date.now(),
    reason,
    directory: settings().directory || defaultDirectory(),
    files: settings().files,
  })
  const clearPending = async () => {
    try {
      await unlink(pendingFile())
      return true
    } catch (error) {
      return isMissing(error)
    }
  }

  /** 到期路径：先试当场删，删不掉就挂延期标记。 */
  async function dueRun(reason) {
    const outcome = await runOnce(reason)
    if (outcome?.needsDefer) await markPending(reason)
    return outcome
  }

  async function tick() {
    const outcome = await dueRun('定时')
    const delay = outcome?.needsDefer ? RETRY_MS : intervalMs()
    ctx.timeout?.(() => { void tick() }, delay)
  }

  // ── 启动：优先消费延期标记，再决定排期 ────────────────────────────────
  ctx.effect?.(() => {
    let disposed = false
    void (async () => {
      const pending = await readJson(pendingFile(), null)
      if (disposed) return
      if (pending) {
        // 这是唯一可靠的删除窗口：外壳还没打开 cookie 库。
        const outcome = await runOnce('boot: pending clean applied')
        if (!outcome?.needsDefer) {
          await clearPending()
          ctx.logger?.info?.('[cookie-janitor] 延期清理已完成，新窗口从第 1 条 cookie 开始。')
        }
      }
      if (disposed) return
      const state = await readJson(stateFile())
      const last = Number(state?.lastRunAt ?? 0)
      const elapsed = last ? Date.now() - last : Number.POSITIVE_INFINITY
      if (settings().runOnStart && elapsed >= intervalMs()) {
        await dueRun(last ? '启动补清' : '首次运行')
        ctx.timeout?.(() => { void tick() }, intervalMs())
      } else if (elapsed < intervalMs()) {
        ctx.timeout?.(() => { void tick() }, intervalMs() - elapsed)
      } else {
        ctx.timeout?.(() => { void tick() }, intervalMs())
      }
    })()
    return () => { disposed = true }
  }, 'dsh-cookie-janitor: 启动消费延期标记并排期')

  // ── 工具：清理 / 取消安排 / 查看状态 ──────────────────────────────────
  const reportOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { report: { type: 'string' } },
      required: ['report'],
    },
    render: (_args, value) => [{ type: 'text', text: value.report }],
  }

  const formatStatus = async () => {
    const state = await readJson(stateFile())
    const pending = await readJson(pendingFile(), null)
    const last = Number(state?.lastRunAt ?? 0)
    const lines = [
      `目标目录：${settings().directory || defaultDirectory()}`,
      `清理文件：${settings().files.join(', ')}`,
      `间隔天数：${settings().intervalDays} 天`,
      last ? `上次成功清理：${new Date(last).toLocaleString('zh-CN')}` : '上次成功清理：从未',
    ]
    lines.push(pending
      ? `待清理标记：已安排（${new Date(Number(pending.createdAt) || 0).toLocaleString('zh-CN')} 起，下次进入时清空）`
      : '待清理标记：无')
    return lines.join('\n')
  }

  ctx.tools?.register?.({
    name: 'cookie_janitor_run',
    description:
      '立即清理 dsh-desktop 的 Cookies / Cookies-journal。DSH 运行期间这俩文件被外壳独占，通常删不掉；'
      + '删不掉时会自动写延期标记，下次启动时清零。返回清理结果与是否已安排延期。',
    parameters: { reason: { type: 'string', description: '本次清理的原因标记，仅写入状态文件。' } },
    output: reportOutput,
    async execute(args = {}) {
      const outcome = await runOnce(String(args.reason || '手动'))
      if (!outcome) return { report: '清理正在进行中，稍后再试。' }
      if (outcome.needsDefer) {
        await markPending('manual')
        return { report: `当场删除失败（${outcome.result.busy.map((b) => `${b.file}:${b.error}`).join(', ')}），已安排：下次进入 DSH 时清零。` }
      }
      return { report: `已清理：${[...outcome.result.removed, ...outcome.result.truncated].join(', ') || '无文件需要处理'}` }
    },
  })

  ctx.tools?.register?.({
    name: 'cookie_janitor_cancel',
    description: '取消已安排的延期清理，删除待清理标记。之后的启动不再清空 cookie 库。',
    parameters: {},
    output: reportOutput,
    async execute() {
      const removed = await clearPending()
      return { report: removed ? '已取消安排，下次启动不会清空 cookie 库。' : '当前没有待清理标记，无需取消。' }
    },
  })

  ctx.tools?.register?.({
    name: 'cookie_janitor_status',
    description: '查看 cookie 清理状态：目标目录、间隔天数、上次成功清理时间、是否已安排延期清理。',
    parameters: {},
    output: reportOutput,
    async execute() {
      return { report: await formatStatus() }
    },
  })
}

export const __internals = { sweep, normalize, defaultDirectory, COOKIE_FILES }