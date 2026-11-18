// dsh-skill-gate — 会话级技能门禁与加载审计（宿主侧）
//
// 目标：
//   1. 默认模型只看得到技能名与描述（DSH 原生就是这样），正文需要用户授权才读得到。
//   2. 每个会话独立：一个会话里的授权/记录不影响别的会话。
//   3. 记录模型真正读到了什么（skill 工具成功加载 + read 直读 SKILL.md）。
//
// 不改变磁盘上的任何技能文件，也不改变 DSH 的技能加载机制。

import { readdir, readFile, writeFile, mkdir, access, stat } from 'node:fs/promises'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

export const name = 'dsh-skill-gate'
export const inject = ['tools']

const ROUTE = '/skill-gate/api'
const SKILL_TOOL = 'skill'
const READ_TOOL = 'read'
const SHELL_TOOLS = ['pwsh', 'bash']

/** 每会话状态：全部在内存里，进程退出即消失（单会话级别，不为别的会话花钱）。 */
const states = new Map()

function stateOf(sessionId) {
  let s = states.get(sessionId)
  if (s === undefined) {
    s = {
      mode: 'auto',        // auto = 模型自主读取；manual = 需用户放行
      allowed: new Set(),  // 手动模式下已放行的技能
      loads: new Map(),    // skill 名 -> { count, lastAt, byTool }
      pending: new Map(),  // 模型请求但未放行：skill 名 -> 时间戳
      reads: [],           // 最近读到的记录 { name, at, via }
      pins: new Map(),     // 固定技能: name -> { content, summary, path, fullCount, autoCount, stale, needsManual }
      createdAt: Date.now(),
    }
    states.set(sessionId, s)
  }
  return s
}

function sessionIdOf(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.agentId ?? agent?.id ?? ''
}

function skillNameOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  const v = args.name ?? args.skill
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

/** 只接受本机回环请求，挡掉 DNS rebinding 与跨站表单。 */
function isTrusted(req) {
  const addr = req?.socket?.remoteAddress ?? ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!loopback) return false
  const site = String(req.headers?.['sec-fetch-site'] ?? '')
  if (site === 'cross-site') return false
  return true
}

export function apply(ctx) {
  // ---------- 技能目录（按会话缓存，来源是 agent 自己的 skills 服务） ----------
  //
  // 宿主根作用域的 ctx.skills 与模型看到的那份不是同一层：
  // 项目级与用户级 provider 挂在 agent/preset 作用域里，根作用域查不到。
  // 所以列表优先用 agent.ctx.get('skills')，与模型目录同源。
  const catalogBySession = new Map() // sessionId -> { at, cwd, items, changed, scannedAt }
  const cwdBySession = new Map()
  let lastRevs = new Map() // 上次扫描到的 name -> rev

  /** 与上次扫描比对，找出磁盘上内容变过的技能。 */
  function diffRevs(items) {
    const next = new Map()
    const changed = []
    for (const item of items) {
      if (typeof item.rev !== 'string' || item.rev === '') continue
      next.set(item.name, item.rev)
      const prev = lastRevs.get(item.name)
      if (prev !== undefined && prev !== item.rev) changed.push(item.name)
    }
    lastRevs = next
    return changed
  }

  function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh')
  }

  function agentsHome() {
    return process.env.AGENTS_HOME || join(homedir(), '.agents')
  }

  /** 项目根 = 最近的含 .git 的祖先；没有就用 cwd（与 dsh-skill-filesystem 同口径）。 */
  async function projectRootOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return ''
    let cur = cwd
    for (let i = 0; i < 12; i += 1) {
      try { await access(join(cur, '.git')); return cur } catch { /* 继续向上 */ }
      const up = dirname(cur)
      if (up === cur) break
      cur = up
    }
    return cwd
  }

  function parseFrontmatter(text) {
    if (typeof text !== 'string') return undefined
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (m === null) return undefined
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (kv === null) continue
      let value = kv[2].trim()
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      }
      meta[kv[1]] = value
    }
    return meta
  }

  async function scanSkillDir(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const p = join(dir, entry.name, 'SKILL.md')
      let text
      let rev = ''
      try {
        text = await readFile(p, 'utf8')
        try {
          const st = await stat(p)
          rev = String(st.mtimeMs) + ':' + String(st.size)
        } catch { rev = String(text.length) }
      } catch { continue }
      const meta = parseFrontmatter(text)
      if (meta === undefined || typeof meta.name !== 'string' || meta.name === '') continue
      out.push({
        name: meta.name,
        description: typeof meta.description === 'string' ? meta.description : '',
        whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : '',
        path: p,
        chars: text.length,
        tokens: estimateTokens(text),
        rev,
      })
    }
    return out
  }

  /** 直接按 DSH 的默认根扫盘，作为技能服务的兜底（保证列表完整）。 */
  async function scanDisk(cwd) {
    const roots = []
    const projectRoot = await projectRootOf(cwd)
    if (projectRoot !== '') {
      roots.push(join(projectRoot, '.dsh', 'skills'))
      roots.push(join(projectRoot, '.agents', 'skills'))
    }
    roots.push(join(dshHome(), 'skills'))
    roots.push(join(agentsHome(), 'skills'))
    const merged = []
    const seen = new Set()
    for (const root of roots) {
      for (const item of await scanSkillDir(root)) {
        if (seen.has(item.name)) continue
        seen.add(item.name)
        merged.push(item)
      }
    }
    return merged
  }

  /** 技能组：一套技能一个开关。目前只内置 office 套件，以后可加。 */
  const BUILTIN_GROUPS = [
    { id: 'office', label: 'Office 文档套件', match: (name) => name === 'office' || name.startsWith('office-') },
  ]

  const sizeCache = new Map() // path -> { at, chars, tokens }

  /** 服务返回的技能没有体积（不在扫描根里），补算一次，缓存 60 秒。 */
  async function fillSizes(items) {
    for (const item of items) {
      if (item.tokens > 0 || item.path === '') continue
      const cached = sizeCache.get(item.path)
      if (cached !== undefined && Date.now() - cached.at < 60000) {
        item.chars = cached.chars
        item.tokens = cached.tokens
        continue
      }
      try {
        const text = await readFile(item.path, 'utf8')
        item.chars = text.length
        item.tokens = estimateTokens(text)
        sizeCache.set(item.path, { at: Date.now(), chars: item.chars, tokens: item.tokens })
      } catch { /* 读不到就保持 0 */ }
    }
    return items
  }

  // 自定义组：~/.dsh/skill-gate/groups.json，跨会话共用定义
  let customGroupsCache = { at: 0, list: [] }

  function groupsFilePath() {
    return join(dshHome(), 'skill-gate', 'groups.json')
  }

  async function loadCustomGroups(force) {
    if (force !== true && Date.now() - customGroupsCache.at < 30000) return customGroupsCache.list
    let list = []
    try {
      const raw = await readFile(groupsFilePath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && Array.isArray(parsed.groups)) list = parsed.groups
    } catch { list = [] }
    customGroupsCache = { at: Date.now(), list }
    return list
  }

  async function saveCustomGroups(list) {
    const dir = join(dshHome(), 'skill-gate')
    await mkdir(dir, { recursive: true })
    await writeFile(groupsFilePath(), JSON.stringify({ version: 1, groups: list }, null, 2), 'utf8')
    customGroupsCache = { at: Date.now(), list }
  }

  /** 一个技能只归一个组：自定义组优先，其次内置组。 */
  function groupOf(name) {
    for (const g of customGroupsCache.list) {
      if (Array.isArray(g.names) && g.names.includes(name)) return g.id
    }
    for (const g of BUILTIN_GROUPS) {
      if (g.match(name)) return g.id
    }
    return ''
  }

  /** 内置中文名与一句话简介；~/.dsh/skill-gate/labels.json 可覆盖/扩充。 */
  const BUILTIN_LABELS = {
    'plugin-install-check': { label: '插件安装体检', summary: '装插件前先查安全性：让模型装不等于安全，含体检五问' },
    'plugin-local-patches': { label: '插件本地补丁', summary: '改插件源码、打补丁、升级后对账，防补丁丢失' },
    'plugin-fork-merge': { label: '插件合并判断', summary: '两个插件能不能合并、功能是否重复，先判后合' },
    'watch-video': { label: '看视频', summary: '场景检测切段 + 联系表，代替均匀抽帧' },
    'ego-browser': { label: '浏览器操作', summary: '打开网页、填表、点击、截图、抓数据' },
    'lieflat-less-ai-tone': { label: '去 AI 味', summary: '检测 AI 腔、给改写方案、复测前后对比' },
    'software-install-layout': { label: '软件安装布局', summary: '装哪个盘、目录怎么摆：body/mods/loads/back 四件套' },
    'diagnose-windows-sandbox-acl': { label: 'Windows 沙箱 ACL 诊断', summary: '沙箱读写被拒时，检查路径与各级父目录权限并修复' },
    'office': { label: 'Office 总入口', summary: '文档、表格、演示、PDF 的总调度' },
    'office-docx': { label: 'Word 文档', summary: '创建、读取、编辑、校验 .docx' },
    'office-pptx': { label: 'PPT 演示', summary: '创建、读取、编辑、校验 .pptx' },
    'office-xlsx': { label: 'Excel 表格', summary: '创建、读取、编辑、校验 .xlsx' },
    'office-export-pdf': { label: '导出 PDF', summary: '用 LibreOffice Kit 把 Office 文档转 PDF' },
    'office-recalculate': { label: '表格重算', summary: '刷新公式缓存并核对计算值' },
    'office-render': { label: '文档渲染', summary: '把文档渲染成图片，检查版面' },
  }

  let labelsCache = { at: 0, map: {} }

  async function readLabels() {
    if (Date.now() - labelsCache.at < 60000 && Object.keys(labelsCache.map).length > 0) return labelsCache.map
    let user = {}
    try {
      const raw = await readFile(join(dshHome(), 'skill-gate', 'labels.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') user = parsed
    } catch { /* 没有就只用内置 */ }
    const map = Object.assign({}, BUILTIN_LABELS, user)
    labelsCache = { at: Date.now(), map }
    return map
  }

  function withLabels(items, labels) {
    return items.map((item) => ({
      ...item,
      label: labels[item.name]?.label ?? '',
      summary: labels[item.name]?.summary ?? '',
    }))
  }

  function normalize(list) {
    const arr = Array.isArray(list) ? list : list?.skills ?? list?.candidates ?? []
    return arr
      .map((s) => ({
        name: String(s?.name ?? ''),
        description: typeof s?.description === 'string' ? s.description : '',
        whenToUse: typeof s?.whenToUse === 'string' ? s.whenToUse : '',
        path: typeof s?.path === 'string' ? s.path : (s?.resourceBase?.path ?? ''),
      }))
      .filter((s) => s.name !== '')
  }

  /** 会话 id 可能带或不带 'session-' 前缀；两种都认，避免面板与宿主对不上。 */
  function resolveSid(raw) {
    if (typeof raw !== 'string' || raw === '') return ''
    const known = (id) => states.has(id) || catalogBySession.has(id) || cwdBySession.has(id)
    if (known(raw)) return raw
    const prefixed = 'session-' + raw
    if (known(prefixed)) return prefixed
    const stripped = raw.replace(/^session-/, '')
    if (stripped !== raw && known(stripped)) return stripped
    return raw
  }

  function cwdOf(sessionId) {
    const cached = cwdBySession.get(sessionId)
    if (typeof cached === 'string' && cached !== '') return cached
    try {
      const sessions = ctx.get?.('sessions')
      const candidates = [sessionId, sessionId.replace(/^session-/, ''), 'session-' + sessionId.replace(/^session-/, '')]
      for (const id of candidates) {
        const live = sessions?.get?.(id)
        const cwd = live?.header?.cwd ?? live?.meta?.cwd
        if (typeof cwd === 'string' && cwd !== '') { cwdBySession.set(sessionId, cwd); return cwd }
      }
    } catch { /* 会话服务可能还没挂 */ }
    return ''
  }

  /** 服务结果优先，磁盘扫描补全，按名字去重。 */
  function mergeItems(fromService, fromDisk) {
    // 磁盘优先：磁盘是刚读的，服务可能带缓存；服务只补磁盘没有的（如内置 office）。
    const out = []
    const seen = new Set()
    for (const item of fromDisk) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      out.push(item)
    }
    for (const item of fromService) {
      if (seen.has(item.name)) continue
      seen.add(item.name)
      out.push(item)
    }
    return out
  }

  /** 用 agent 自己的技能服务刷新该会话的目录缓存。 */
  async function refreshCatalog(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === '') return
    const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? cwdOf(sessionId)
    if (typeof cwd === 'string' && cwd !== '') cwdBySession.set(sessionId, cwd)
    const skills = agent?.ctx?.get?.('skills') ?? ctx.get?.('skills')
    const disk = await scanDisk(cwd)
    if (skills !== undefined && typeof skills.list === 'function') {
      try {
        const raw = await skills.list(cwd === '' ? {} : { cwd })
        const merged = await fillSizes(mergeItems(normalize(raw), disk))
        catalogBySession.set(sessionId, { at: Date.now(), cwd, items: withLabels(merged, await readLabels()) })
        return
      } catch { /* 落到磁盘结果 */ }
    }
    if (disk.length > 0) {
      catalogBySession.set(sessionId, { at: Date.now(), cwd, items: withLabels(await fillSizes(disk), await readLabels()) })
    }
  }

  async function catalog(sessionId, force) {
    const cached = catalogBySession.get(sessionId)
    if (force !== true && cached !== undefined && Date.now() - cached.at < 5000) return cached.items
    const skills = ctx.get?.('skills')
    const cwd = cwdOf(sessionId)
    const disk = await scanDisk(cwd)
    const labels = await readLabels()
    if (skills !== undefined && typeof skills.list === 'function') {
      try {
        const raw = await skills.list(cwd === '' ? {} : { cwd })
        const items = withLabels(await fillSizes(mergeItems(normalize(raw), disk)), labels)
        const changed = diffRevs(items)
        catalogBySession.set(sessionId, { at: Date.now(), cwd, items, changed, scannedAt: Date.now() })
        return items
      } catch { /* 落到磁盘结果 */ }
    }
    if (disk.length > 0) {
      const items = withLabels(await fillSizes(disk), labels)
      const changed = diffRevs(items)
      catalogBySession.set(sessionId, { at: Date.now(), cwd, items, changed, scannedAt: Date.now() })
      return items
    }
    return cached?.items ?? []
  }

  /** read 直读技能文件也算「读到」——必须同样过门禁。 */
  async function skillOwnedByRead(sessionId, filePath) {
    if (typeof filePath !== 'string' || filePath === '') return undefined
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    if (!norm.includes('/skills/')) return undefined
    const items = await catalog(sessionId)
    for (const item of items) {
      if (item.path === '') continue
      const dir = item.path.replace(/\\/g, '/').toLowerCase()
      if (norm === dir || norm.startsWith(dir.replace(/\/[^/]*$/, '') + '/')) return item.name
    }
    return undefined
  }

  function stripFrontmatter(text) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
    return m === null ? text : text.slice(m[0].length)
  }

  /** 注入一条本地 user 消息（与 dsh-llm 的 createUserMessage 同形）。 */
  function injectedMessage(text, form, extra) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: Object.assign({ kind: 'skill-gate', form }, extra && typeof extra === 'object' ? extra : {}),
    }
  }

  function hashOf(text) {
    try { return createHash('sha256').update(String(text)).digest('hex').slice(0, 16) } catch { return '' }
  }

  /** 粗略 token 估算：CJK 按 1 字 1 token，其余按 3.5 字符 1 token。 */
  function estimateTokens(text) {
    const s = String(text)
    let cjk = 0
    let other = 0
    for (const ch of s) {
      if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/.test(ch)) cjk += 1
      else other += 1
    }
    return Math.round(cjk * 1.0 + other * 0.28)
  }

  /** 从 SKILL.md 提取要点：description + 二级标题，够短、够稳。 */
  function summarizeSkill(meta, text) {
    const lines = []
    if (meta !== undefined && typeof meta.description === 'string' && meta.description !== '') lines.push(meta.description)
    if (meta !== undefined && typeof meta.whenToUse === 'string' && meta.whenToUse !== '') lines.push('适用：' + meta.whenToUse)
    const headings = []
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^##\s+(.+)$/.exec(line)
      if (m !== null && headings.length < 10) headings.push('- ' + m[1].trim())
    }
    if (headings.length > 0) lines.push(headings.join('\n'))
    return lines.join('\n').slice(0, 1200)
  }

  function renderPinnedFull(name, content) {
    return '【本会话已固定技能：' + name + '】\n\n' + content + '\n\n—— 以上为固定技能正文。本会话后续工作请按它执行。'
  }

  function renderPinnedSummary(name, summary) {
    return '【固定技能要点：' + name + '】\n' + summary + '\n（完整正文已因上下文压缩移除；需要细节时调用 skill 工具重新加载。）'
  }

  function renderStaleWarning(name) {
    return '【技能正文已丢失：' + name + '】上下文压缩移除了它的正文，自动恢复次数已用完。请在会话顶部「技能」面板点「重新注入」，否则本会话后续工作可能不符合该技能要求。'
  }

  /** 从会话历史恢复固定状态：注入消息带 source.kind='skill-gate' + name/hash。 */
  async function restoreFromHistory(sessionId) {
    const st = stateOf(sessionId)
    if (st.restored === true) return
    st.restored = true
    try {
      const sessions = ctx.get?.('sessions')
      const live = sessions?.get?.(sessionId)
      if (live === undefined) return
      const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents() : []
      const found = new Map()
      for (const ev of events) {
        if (ev?.type !== 'user/message') continue
        const source = ev?.data?.source
        if (source === null || source === undefined || source.kind !== 'skill-gate') continue
        const name = typeof source.name === 'string' ? source.name : ''
        if (name === '') continue
        found.set(name, { form: source.form, hash: source.hash })
      }
      if (found.size === 0) return
      const items = await catalog(sessionId)
      for (const [name, info] of found) {
        if (st.pins.has(name)) continue
        const item = items.find((x) => x.name === name)
        let body = ''
        let full = ''
        if (item !== undefined) {
          try {
            full = await readFile(item.path, 'utf8')
            body = stripFrontmatter(full).slice(0, 20000)
          } catch { body = '' }
        }
        const currentHash = body === '' ? '' : hashOf(body)
        const changed = typeof info.hash === 'string' && info.hash !== '' && currentHash !== '' && info.hash !== currentHash
        let phase = 'active'
        if (info.form === 'stale-warning') phase = 'needs-manual'
        else if (info.form === 'pinned-summary') phase = 'stale'
        else if (changed) phase = 'outdated'
        st.pins.set(name, {
          content: body,
          summary: item !== undefined ? summarizeSkill(parseFrontmatter(full), full) : '',
          path: item?.path ?? '',
          hash: currentHash,
          rev: item?.rev ?? '',
          chars: body.length,
          tokens: estimateTokens(body),
          fullCount: 0,
          autoCount: 0,
          stale: phase === 'stale',
          needsManual: phase === 'needs-manual',
          outdated: phase === 'outdated',
          warned: phase === 'needs-manual',
          pendingFull: false,
          restored: true,
        })
        st.restoredCount = (st.restoredCount ?? 0) + 1
      }
    } catch { /* 恢复失败不影响主流程 */ }
  }

  function contextWindowOf(sessionId) {
    try {
      const live = ctx.get?.('sessions')?.get?.(sessionId)
      const cw = live?.requestContext?.()?.contextWindow
      if (typeof cw === 'number' && cw > 0) return cw
    } catch { /* 拿不到就返回 0 */ }
    return 0
  }

  /** 固定单个技能：读全文、存摘要与 hash。返回 { ok, error }。 */
  async function pinSkill(sessionId, name) {
    const st = stateOf(sessionId)
    if (st.pins.has(name)) return { ok: true }
    const items = await catalog(sessionId)
    const item = items.find((x) => x.name === name)
    if (item === undefined) return { ok: false, error: 'skill not found' }
    let content = ''
    try { content = await readFile(item.path, 'utf8') } catch { return { ok: false, error: 'SKILL.md unreadable' } }
    const meta = parseFrontmatter(content)
    const body = stripFrontmatter(content)
    st.pins.set(name, {
      content: body.slice(0, 20000),
      summary: summarizeSkill(meta, content),
      path: item.path,
      hash: hashOf(body),
      rev: item.rev ?? '',
      chars: body.length,
      tokens: estimateTokens(body),
      fullCount: 0,
      autoCount: 0,
      stale: false,
      needsManual: false,
      warned: false,
      pendingFull: true,
    })
    return { ok: true }
  }

  function pinStateOf(pin, item) {
    if (pin === undefined) return 'none'
    if (pin.needsManual === true) return 'needs-manual'
    if (pin.outdated === true) return 'outdated'
    if (pin.stale === true) return 'stale'
    // 实时比对：固定之后技能文件被改过，面板要立刻反映
    if (item !== undefined && typeof pin.rev === 'string' && pin.rev !== '' && typeof item.rev === 'string' && item.rev !== '' && pin.rev !== item.rev) {
      return 'outdated'
    }
    return 'active'
  }

  function recordLoad(sessionId, skillName, via) {
    const st = stateOf(sessionId)
    const prev = st.loads.get(skillName) ?? { count: 0, lastAt: 0, byTool: {} }
    prev.count += 1
    prev.lastAt = Date.now()
    prev.byTool[via] = (prev.byTool[via] ?? 0) + 1
    st.loads.set(skillName, prev)
    st.reads.push({ name: skillName, at: Date.now(), via })
    if (st.reads.length > 200) st.reads.splice(0, st.reads.length - 200)
    st.pending.delete(skillName)
  }

  // ---------- 门禁：模型能不能读正文 ----------
  ctx.tools.guard((exec) => {
    try {
      const toolName = exec?.name
      if (typeof toolName !== 'string') return undefined
      const sessionId = sessionIdOf(exec.agent)
      if (sessionId === '') return undefined
      const st = stateOf(sessionId)
      if (st.mode !== 'manual') return undefined

      let skillName
      let path = ''
      if (toolName === SKILL_TOOL) {
        skillName = skillNameOf(exec.arguments)
      } else if (toolName === READ_TOOL) {
        path = String(exec.arguments?.file_path ?? '')
      } else if (toolName === SHELL_TOOLS[0] || toolName === SHELL_TOOLS[1]) {
        const cmd = String(exec.arguments?.command ?? '')
        const shellSkill = matchCachedSkillInCommand(cmd, sessionId)
        if (shellSkill === undefined) return undefined
        if (st.allowed.has(shellSkill)) return undefined
        st.pending.set(shellSkill, Date.now())
        return '[skill-gate] 本会话处于「手动授权」模式：技能「' + shellSkill + '」还没有放行，不能用 shell 直接读它的文件。请让用户在本会话顶部「技能」面板里放行。'
      } else {
        return undefined
      }
      if (toolName === READ_TOOL) {
        // read 是异步判定的，无法在同步 guard 里查目录；用同步缓存。
        skillName = matchCachedSkill(path, sessionId)
      }
      if (typeof skillName !== 'string' || skillName === '') return undefined
      if (st.allowed.has(skillName)) return undefined

      st.pending.set(skillName, Date.now())
      const how = toolName === READ_TOOL ? '直接读技能文件' : '加载技能'
      return `[skill-gate] 本会话处于「手动授权」模式：技能「${skillName}」还没有放行，${how}被拦下了。请先告诉用户你要它做什么，让用户在本会话顶部「技能」面板里放行；不要绕路（用 read 读 SKILL.md 同样会被拦）。`
    } catch {
      // 门禁自身出错时放行，绝不把整个回合卡死。
      return undefined
    }
  })

  /** guard 是同步的，这里用最近一次目录快照做路径归属判断。 */
  function matchCachedSkill(filePath, sessionId) {
    if (typeof filePath !== 'string' || filePath === '') return undefined
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    if (!norm.includes('/skills/')) return undefined
    const items = catalogBySession.get(sessionId)?.items ?? []
    for (const item of items) {
      if (item.path === '') continue
      const dir = item.path.replace(/\\/g, '/').toLowerCase()
      const root = dir.replace(/\/[^/]*$/, '')
      if (norm.startsWith(root + '/')) return item.name
    }
    return undefined
  }

  /** 命令里出现技能目录名或 SKILL.md，就按「试图读技能正文」处理。 */
  function matchCachedSkillInCommand(command, sessionId) {
    if (typeof command !== 'string' || command === '') return undefined
    const norm = command.replace(/\\/g, '/').toLowerCase()
    const items = catalogBySession.get(sessionId)?.items ?? []
    for (const item of items) {
      if (item.path === '') continue
      const dir = item.path.replace(/\\/g, '/').toLowerCase().replace(/\/[^/]*$/, '')
      const base = dir.split('/').filter(Boolean).pop() || ''
      if (base !== '' && norm.includes('/' + base)) return item.name
    }
    if (norm.includes('skill.md')) return '__skill-file__'
    return undefined
  }

  // ---------- 审计：真正读到了才算 ----------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (exec?.name === SKILL_TOOL && result?.isError !== true) {
        const sessionId = sessionIdOf(exec.agent)
        const skillName = skillNameOf(exec.arguments)
        if (sessionId !== '' && skillName !== undefined) recordLoad(sessionId, skillName, 'skill')
      }
      if (exec?.name === READ_TOOL && result?.isError !== true) {
        const sessionId = sessionIdOf(exec.agent)
        const name = matchCachedSkill(String(exec.arguments?.file_path ?? ''), sessionId)
        if (sessionId !== '' && name !== undefined) recordLoad(sessionId, name, 'read')
      }
    } catch { /* 观测失败不影响工具结果 */ }
    return next()
  })

  // ---------- 新回合：把上一轮的待授权请求留着，提醒在面板里处理 ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === '') return decision
      const st = stateOf(sessionId)
      await refreshCatalog(agent)
      if (st.pins.size === 0) return decision
      const injected = []
      const now = Date.now()
      for (const [name, pin] of st.pins) {
        if (pin.pendingFull === true) {
          pin.pendingFull = false
          pin.fullCount = (pin.fullCount ?? 0) + 1
          pin.stale = false
          pin.needsManual = false
          pin.warned = false
          pin.injectedAt = now
          injected.push(injectedMessage(renderPinnedFull(name, pin.content), 'pinned-full', { name, hash: pin.hash ?? '' }))
          continue
        }
        if (pin.stale === true) {
          const autoCount = pin.autoCount ?? 0
          if (autoCount < 2) {
            pin.autoCount = autoCount + 1
            pin.stale = false
            pin.warned = false
            pin.injectedAt = now
            injected.push(injectedMessage(renderPinnedSummary(name, pin.summary), 'pinned-summary', { name, hash: pin.hash ?? '' }))
          } else {
            pin.needsManual = true
            if (pin.warned !== true) {
              pin.warned = true
              injected.push(injectedMessage(renderStaleWarning(name), 'stale-warning', { name, hash: pin.hash ?? '' }))
            }
          }
        }
      }
      if (injected.length === 0) return decision
      return { ...decision, messages: [...(decision.messages ?? []), ...injected] }
    } catch {
      return decision
    }
  })

  // 压缩（compaction）会把早期消息凝练掉：技能正文可能不在上下文了。
  // 这里只做标记，注入留到下一个 pre-step，避免在事件里反复触发。
  ctx.on('session/event', (session, event) => {
    try {
      if (typeof event?.type !== 'string') return
      if (event.type !== 'compaction/prune' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') return
      const id = String(session?.id ?? '')
      const st = states.get(id) ?? states.get(id.replace(/^session-/, ''))
      if (st === undefined) return
      for (const pin of st.pins.values()) { pin.stale = true }
    } catch { /* 忽略 */ }
  }, { global: true })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId !== '') {
      states.delete(sessionId)
      catalogBySession.delete(sessionId)
      cwdBySession.delete(sessionId)
    }
  })

  // ---------- HTTP API（面板用） ----------
  const routes = {
    handler: async (req, res) => {
      if (!isTrusted(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const is = (p, m) => url.pathname === ROUTE + p && req.method === m
      try {
        if (is('/state', 'GET')) {
          const sessionId = resolveSid(url.searchParams.get('sessionId') ?? '')
          const st = stateOf(sessionId)
          await loadCustomGroups()
          await restoreFromHistory(sessionId)
          const force = url.searchParams.get('refresh') === '1'
          const items = await catalog(sessionId, force)
          const skills = items.map((item) => {
            const load = st.loads.get(item.name)
            return {
              name: item.name,
              label: item.label ?? '',
              summary: item.summary ?? '',
              description: item.description,
              path: item.path,
              loaded: load?.count ?? 0,
              lastAt: load?.lastAt ?? 0,
              allowed: st.allowed.has(item.name),
              pending: st.pending.has(item.name),
              pinned: st.pins.has(item.name),
              pinState: pinStateOf(st.pins.get(item.name), item),
              autoCount: st.pins.get(item.name)?.autoCount ?? 0,
              chars: st.pins.get(item.name)?.chars ?? item.chars ?? 0,
              tokens: st.pins.get(item.name)?.tokens ?? item.tokens ?? 0,
              group: groupOf(item.name),
            }
          })
          const loadedCount = skills.filter((s) => s.loaded > 0).length
          const pinnedCount = skills.filter((s) => s.pinned).length
          const staleCount = skills.filter((s) => s.pinState === 'stale' || s.pinState === 'needs-manual' || s.pinState === 'outdated').length
          const groupDefs = [
            ...customGroupsCache.list.map((g) => ({ id: g.id, label: g.label, builtin: false })),
            ...BUILTIN_GROUPS.map((g) => ({ id: g.id, label: g.label, builtin: true })),
          ]
          const groups = groupDefs.map((g) => {
            const members = skills.filter((s) => s.group === g.id)
            return {
              id: g.id,
              label: g.label,
              builtin: g.builtin,
              names: members.map((s) => s.name),
              total: members.length,
              tokens: members.reduce((sum, s) => sum + (s.tokens ?? 0), 0),
              pinnedCount: members.filter((s) => s.pinned).length,
              loadedCount: members.filter((s) => s.loaded > 0).length,
              allowedCount: members.filter((s) => s.allowed).length,
            }
          }).filter((g) => g.total > 0)
          const pinnedTokens = skills.filter((s) => s.pinned).reduce((sum, s) => sum + (s.tokens ?? 0), 0)
          const contextWindow = contextWindowOf(sessionId)
          const pinnedPercent = contextWindow > 0 ? Math.round((pinnedTokens / contextWindow) * 1000) / 10 : 0
          sendJson(res, 200, {
            ok: true,
            sessionId,
            mode: st.mode,
            skills,
            stats: {
              total: skills.length,
              loaded: loadedCount,
              pending: st.pending.size,
              pinned: pinnedCount,
              stale: staleCount,
              pinnedTokens,
              contextWindow,
              pinnedPercent,
              restored: st.restoredCount ?? 0,
            },
            groups,
            catalogMeta: {
              scannedAt: catalogBySession.get(sessionId)?.scannedAt ?? 0,
              changed: catalogBySession.get(sessionId)?.changed ?? [],
            },
            reads: st.reads.slice(-40).reverse(),
          })
          return
        }
        if (is('/mode', 'POST')) {
          const body = await readJsonBody(req)
          const st = stateOf(resolveSid(String(body.sessionId ?? '')))
          const mode = body.mode === 'manual' ? 'manual' : 'auto'
          st.mode = mode
          if (mode === 'auto') st.pending.clear()
          sendJson(res, 200, { ok: true, mode })
          return
        }
        if (is('/allow', 'POST')) {
          const body = await readJsonBody(req)
          const st = stateOf(resolveSid(String(body.sessionId ?? '')))
          const name = String(body.name ?? '')
          if (name === '') { sendJson(res, 400, { ok: false, error: 'name required' }); return }
          if (body.allow === false) st.allowed.delete(name)
          else st.allowed.add(name)
          st.pending.delete(name)
          sendJson(res, 200, { ok: true, name, allowed: st.allowed.has(name) })
          return
        }
        if (is('/pin', 'POST')) {
          const body = await readJsonBody(req)
          const sessionId = resolveSid(String(body.sessionId ?? ''))
          const name = String(body.name ?? '')
          if (name === '') { sendJson(res, 400, { ok: false, error: 'name required' }); return }
          const result = await pinSkill(sessionId, name)
          if (result.ok !== true) { sendJson(res, 404, { ok: false, error: result.error }); return }
          sendJson(res, 200, { ok: true, name, pinned: true })
          return
        }
        if (is('/unpin', 'POST')) {
          const body = await readJsonBody(req)
          const st = stateOf(resolveSid(String(body.sessionId ?? '')))
          st.pins.delete(String(body.name ?? ''))
          sendJson(res, 200, { ok: true })
          return
        }
        if (is('/reinject', 'POST')) {
          const body = await readJsonBody(req)
          const st = stateOf(resolveSid(String(body.sessionId ?? '')))
          const pin = st.pins.get(String(body.name ?? ''))
          if (pin === undefined) { sendJson(res, 404, { ok: false, error: 'not pinned' }); return }
          pin.pendingFull = true
          pin.autoCount = 0
          pin.needsManual = false
          pin.warned = false
          sendJson(res, 200, { ok: true })
          return
        }
        if (is('/groups/create', 'POST')) {
          const body = await readJsonBody(req)
          const label = String(body.label ?? '').trim()
          const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string' && n !== '') : []
          if (label === '') { sendJson(res, 400, { ok: false, error: '请给分组起个名字' }); return }
          if (names.length === 0) { sendJson(res, 400, { ok: false, error: '先勾选至少一个技能' }); return }
          await loadCustomGroups(true)
          const list = customGroupsCache.list.slice()
          // 一个技能只归一个自定义组：从其它组里摘出去
          for (const g of list) {
            if (Array.isArray(g.names)) g.names = g.names.filter((n) => !names.includes(n))
          }
          const kept = list.filter((g) => Array.isArray(g.names) && g.names.length > 0)
          const id = 'custom-' + randomUUID().slice(0, 8)
          kept.push({ id, label, names, createdAt: new Date().toISOString() })
          await saveCustomGroups(kept)
          sendJson(res, 200, { ok: true, id, label, count: names.length })
          return
        }
        if (is('/groups/delete', 'POST')) {
          const body = await readJsonBody(req)
          const id = String(body.id ?? '')
          await loadCustomGroups(true)
          const next = customGroupsCache.list.filter((g) => g.id !== id)
          await saveCustomGroups(next)
          sendJson(res, 200, { ok: true, removed: id })
          return
        }
        if (is('/group', 'POST')) {
          const body = await readJsonBody(req)
          const sessionId = resolveSid(String(body.sessionId ?? ''))
          const groupId = String(body.groupId ?? '')
          const action = String(body.action ?? '')
          await loadCustomGroups()
          const customGroup = customGroupsCache.list.find((g) => g.id === groupId)
          const builtinGroup = BUILTIN_GROUPS.find((g) => g.id === groupId)
          if (customGroup === undefined && builtinGroup === undefined) { sendJson(res, 404, { ok: false, error: 'unknown group' }); return }
          const items = await catalog(sessionId)
          const known = new Set(items.map((i) => i.name))
          const names = customGroup !== undefined
            ? (Array.isArray(customGroup.names) ? customGroup.names : []).filter((n) => known.has(n))
            : items.filter((i) => groupOf(i.name) === groupId).map((i) => i.name)
          const st = stateOf(sessionId)
          if (action === 'pin') {
            let failed = 0
            for (const n of names) {
              const r = await pinSkill(sessionId, n)
              if (r.ok !== true) failed += 1
            }
            sendJson(res, 200, { ok: true, count: names.length, failed })
            return
          }
          if (action === 'unpin') { for (const n of names) st.pins.delete(n) }
          else if (action === 'allow') { for (const n of names) st.allowed.add(n) }
          else if (action === 'allow-off') { for (const n of names) st.allowed.delete(n) }
          else { sendJson(res, 400, { ok: false, error: 'unknown action' }); return }
          sendJson(res, 200, { ok: true, count: names.length })
          return
        }
        if (is('/allow-all', 'POST')) {
          const body = await readJsonBody(req)
          const sid2 = resolveSid(String(body.sessionId ?? ''))
          const st = stateOf(sid2)
          const items = await catalog(sid2)
          for (const item of items) st.allowed.add(item.name)
          st.pending.clear()
          sendJson(res, 200, { ok: true, allowed: st.allowed.size })
          return
        }
        if (is('/reset', 'POST')) {
          const body = await readJsonBody(req)
          const st = stateOf(resolveSid(String(body.sessionId ?? '')))
          st.allowed.clear()
          st.pending.clear()
          st.loads.clear()
          st.pins.clear()
          st.reads.length = 0
          sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  // webServer 在插件 apply 之后才挂载，必须懒注册。
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (server === undefined || typeof server.register !== 'function') return
    let dispose
    try {
      dispose = server.register({ kind: 'prefix', path: ROUTE, handler: routes.handler })
    } catch {
      return
    }
    if (typeof scope.effect === 'function' && typeof dispose === 'function') {
      scope.effect(() => dispose, 'dsh-skill-gate: panel api')
    }
  })
}