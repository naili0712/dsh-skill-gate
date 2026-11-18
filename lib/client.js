/**
 * dsh-skill-gate — 会话顶部「技能」面板（浏览器侧）
 */
window.__ModuleLoader__.load({ id: 'dsh-skill-gate', factory: function (require) {
  var React = require('react')
  var h = React.createElement

  var API = '/skill-gate/api'
  var EXPAND_KEY = 'dsh-skill-gate:expanded'

  function loadExpanded() {
    try {
      var raw = window.localStorage.getItem(EXPAND_KEY)
      var parsed = raw ? JSON.parse(raw) : {}
      if (parsed && typeof parsed === 'object') return parsed
    } catch (e) { /* 隐私模式或禁用存储时退回空 */ }
    return {}
  }

  function saveExpanded(next) {
    try { window.localStorage.setItem(EXPAND_KEY, JSON.stringify(next)) } catch (e) { /* 存不下就算了 */ }
  }
  var POLL_MS = 2500
  var TIMER_SET = 'set' + 'Interval'
  var TIMER_CLEAR = 'clear' + 'Interval'

  var COLOR = {
    ok: '#2ea043',
    warn: '#d29922',
    info: '#388bfd',
    muted: 'rgba(127,127,127,0.75)',
    line: 'rgba(127,127,127,0.18)',
  }

  function badge(text, color, filled) {
    return h('span', {
      style: {
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '18px',
        color: filled ? '#fff' : color,
        background: filled ? color : 'transparent',
        border: '1px solid ' + color,
        whiteSpace: 'nowrap',
      },
    }, text)
  }

  function fetchState(sessionId, force) {
    var url = API + '/state?sessionId=' + encodeURIComponent(sessionId) + (force ? '&refresh=1' : '')
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json() })
  }

  function fmtTokens(n) {
    if (!n) return '0'
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
    return String(n)
  }

  function buttonStyle(active, disabled) {
    return {
      fontSize: '12px',
      padding: '4px 10px',
      borderRadius: '6px',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      color: active ? '#fff' : 'inherit',
      background: active ? COLOR.info : 'transparent',
      border: '1px solid ' + (active ? COLOR.info : COLOR.line),
      fontFamily: 'inherit',
    }
  }

  function SkillGatePanel(props) {
    var sessionId = props && props.sessionId ? String(props.sessionId) : ''
    var stateHook = React.useState(null)
    var data = stateHook[0]
    var setData = stateHook[1]
    var errHook = React.useState('')
    var error = errHook[0]
    var setError = errHook[1]
    var busyHook = React.useState('')
    var busy = busyHook[0]
    var setBusy = busyHook[1]
    var selHook = React.useState({})
    var selected = selHook[0]
    var setSelected = selHook[1]
    var expandHook = React.useState(loadExpanded)
    var expanded = expandHook[0]
    var setExpandedRaw = expandHook[1]
    function setExpanded(next) {
      saveExpanded(next)
      setExpandedRaw(next)
    }
    var namingHook = React.useState(false)
    var naming = namingHook[0]
    var setNaming = namingHook[1]
    var nameHook = React.useState('')
    var groupName = nameHook[0]
    var setGroupName = nameHook[1]
    function toggleSelect(name) {
      var next = Object.assign({}, selected)
      if (next[name]) delete next[name]
      else next[name] = true
      setSelected(next)
    }

    React.useEffect(function () {
      var alive = true
      function tick() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        fetchState(sessionId).then(function (d) {
          if (!alive) return
          if (d && d.ok) { setData(d); setError('') }
          else setError((d && d.error) || '读取失败')
        }).catch(function (e) {
          if (alive) setError(String(e && e.message ? e.message : e))
        })
      }
      tick()
      var timer = window[TIMER_SET](tick, POLL_MS)
      return function () { alive = false; window[TIMER_CLEAR](timer) }
    }, [sessionId])

    function act(path, body) {
      setBusy(path)
      post(path, Object.assign({ sessionId: sessionId }, body)).then(function () {
        return fetchState(sessionId)
      }).then(function (d) {
        if (d && d.ok) { setData(d); setError('') }
      }).catch(function (e) {
        setError(String(e && e.message ? e.message : e))
      }).then(function () { setBusy('') })
    }

    if (!sessionId) {
      return h('div', { style: { padding: '18px', color: COLOR.muted, fontSize: '13px' } }, '还没有选中会话。')
    }

    var mode = data ? data.mode : 'auto'
    var skills = data ? data.skills : []
    var stats = data ? data.stats : { total: 0, loaded: 0, pending: 0 }

    var modeBar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } }, [
      h('div', { key: 'label', style: { fontSize: '12px', color: COLOR.muted } }, '授权模式'),
      h('button', {
        key: 'auto',
        onClick: function () { act('/mode', { mode: 'auto' }) },
        style: buttonStyle(mode === 'auto', busy === '/mode'),
      }, '自动授权（模型自主读取）'),
      h('button', {
        key: 'manual',
        onClick: function () { act('/mode', { mode: 'manual' }) },
        style: buttonStyle(mode === 'manual', busy === '/mode'),
      }, '手动授权（读取需放行）'),
      h('div', { key: 'spacer', style: { flex: 1 } }),
      h('button', {
        key: 'pin',
        onClick: function () {
          var names = Object.keys(selected)
          if (names.length === 0) { act('/pin', { name: '__none__' }); return }
          Promise.all(names.map(function (n) { return post('/pin', { sessionId: sessionId, name: n }) }))
            .then(function () { return fetchState(sessionId) })
            .then(function (d) { if (d && d.ok) setData(d) })
        },
        style: buttonStyle(false, false),
      }, '加载所选' + (Object.keys(selected).length > 0 ? '（' + Object.keys(selected).length + '）' : '')),
      h('button', {
        key: 'newgroup',
        onClick: function () {
          if (Object.keys(selected).length === 0) { setError('先勾选要放进分组的技能'); return }
          setNaming(true)
          setError('')
        },
        style: buttonStyle(false, false),
      }, '新建分组'),
      h('button', {
        key: 'all',
        onClick: function () { act('/allow-all', {}) },
        style: buttonStyle(false, busy === '/allow-all'),
      }, '全部放行'),
      h('button', {
        key: 'reset',
        onClick: function () { act('/reset', {}) },
        style: buttonStyle(false, busy === '/reset'),
      }, '重置本会话'),
    ])

    var namingBar = naming ? h('div', {
      style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', padding: '8px', border: '1px solid ' + COLOR.line, borderRadius: '6px' },
    }, [
      h('span', { key: 'l', style: { fontSize: '12px', color: COLOR.muted } }, '分组名'),
      h('input', {
        key: 'i',
        value: groupName,
        placeholder: '例如：写作套件',
        onChange: function (e) { setGroupName(e.target.value) },
        style: { flex: 1, fontSize: '12px', padding: '4px 8px', borderRadius: '4px', border: '1px solid ' + COLOR.line, background: 'transparent', color: 'inherit', fontFamily: 'inherit' },
      }),
      h('span', { key: 'c', style: { fontSize: '11px', color: COLOR.muted } }, '已选 ' + Object.keys(selected).length + ' 个'),
      h('button', {
        key: 'ok',
        onClick: function () {
          if (groupName.trim() === '') { setError('分组名不能为空'); return }
          post('/groups/create', { label: groupName.trim(), names: Object.keys(selected) })
            .then(function (r) {
              if (r && r.ok) { setNaming(false); setGroupName(''); setSelected({}); return fetchState(sessionId) }
              setError((r && r.error) || '创建失败')
            })
            .then(function (d) { if (d && d.ok) setData(d) })
            .catch(function (e) { setError(String(e && e.message ? e.message : e)) })
        },
        style: buttonStyle(true, false),
      }, '创建'),
      h('button', {
        key: 'no',
        onClick: function () { setNaming(false); setGroupName('') },
        style: buttonStyle(false, false),
      }, '取消'),
    ]) : null

    var summary = h('div', { style: { fontSize: '12px', color: COLOR.muted, marginBottom: '4px' } },
      '本会话：' + stats.total + ' 个可见技能 · 已读到 ' + stats.loaded + ' 个'
      + (stats.pending > 0 ? ' · 待授权 ' + stats.pending + ' 个' : '')
      + (stats.pinned > 0 ? ' · 已固定 ' + stats.pinned + ' 个，约 ' + fmtTokens(stats.pinnedTokens) + ' token'
          + (stats.pinnedPercent > 0 ? '（占当前上下文 ' + stats.pinnedPercent + '%）' : '') : '')
      + (stats.stale > 0 ? ' · 需要处理 ' + stats.stale + ' 个' : ''))

    var restoreLine = stats.restored > 0
      ? h('div', { style: { fontSize: '11px', color: COLOR.info, marginBottom: '10px' } },
          '已从会话历史恢复 ' + stats.restored + ' 个固定技能（重启/重开也能对上）')
      : h('div', { style: { marginBottom: '6px' } })

    function renderSkill(s, indent) {
      var status = []
      if (s.loaded > 0) status.push(badge('已读 ×' + s.loaded, COLOR.ok, false))
      if (s.pinned) status.push(badge('已固定', COLOR.info, false))
      if (s.pinState === 'needs-manual') status.push(badge('正文已压缩·待重新注入', '#f85149', true))
      else if (s.pinState === 'outdated') status.push(badge('技能已更新·建议重新注入', COLOR.warn, true))
      else if (s.pinState === 'stale') status.push(badge('压缩后待补', COLOR.warn, false))
      if (s.loaded === 0 && !s.pinned) status.push(badge('未读', COLOR.muted, false))
      if (s.pending) status.push(badge('待授权', COLOR.warn, true))
      if (mode === 'manual' && s.allowed && !s.pinned) status.push(badge('已放行', COLOR.info, false))

      var right = []
      if (s.pinned && (s.pinState === 'needs-manual' || s.pinState === 'stale' || s.pinState === 'outdated')) {
        right.push(h('button', {
          key: 'reinject',
          onClick: function () { act('/reinject', { name: s.name }) },
          style: buttonStyle(true, busy === '/reinject'),
        }, '重新注入'))
      }
      if (s.pinned) {
        right.push(h('button', {
          key: 'unpin',
          onClick: function () { act('/unpin', { name: s.name }) },
          style: buttonStyle(false, busy === '/unpin'),
        }, '取消固定'))
      }
      if (mode === 'manual') {
        right.push(h('button', {
          key: 'toggle',
          onClick: function () { act('/allow', { name: s.name, allow: !s.allowed }) },
          style: buttonStyle(false, busy === '/allow'),
        }, s.allowed ? '收回' : '放行'))
      }
      return h('div', {
        key: s.name,
        style: {
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '7px 4px', borderBottom: '1px solid ' + COLOR.line,
          marginLeft: indent ? '20px' : 0,
        },
      }, [
        h('input', {
          key: 'chk',
          type: 'checkbox',
          checked: selected[s.name] === true,
          onChange: function () { toggleSelect(s.name) },
          style: { cursor: 'pointer', flex: 'none' },
        }),
        h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          h('div', { key: 'name', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
            h('span', { key: 'n', style: { fontSize: '13px' } }, s.label || s.name),
            s.label ? h('span', { key: 'raw', style: { fontSize: '11px', color: COLOR.muted, fontFamily: 'ui-monospace, monospace' } }, s.name) : null,
            h('span', { key: 's', style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } }, status),
          ]),
          h('div', {
            key: 'desc',
            style: { fontSize: '11px', color: COLOR.muted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: s.description || '',
          }, s.summary || s.description || '（无描述）'),
        ]),
        h('span', { key: 'size', style: { fontSize: '11px', color: COLOR.muted, flex: 'none' }, title: (s.chars || 0) + ' 字符' }, fmtTokens(s.tokens) + ' tok'),
        h('div', { key: 'act', style: { display: 'flex', gap: '6px' } }, right),
      ])
    }

    var meta = (data && data.catalogMeta) ? data.catalogMeta : { scannedAt: 0, changed: [] }
    var changedList = meta.changed || []
    var scanTime = meta.scannedAt ? new Date(meta.scannedAt).toLocaleTimeString() : '未扫描'
    var statusBar = h('div', {
      key: 'status',
      style: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        fontSize: '11px', color: COLOR.muted, marginBottom: '10px',
        padding: '5px 8px', border: '1px solid ' + COLOR.line, borderRadius: '5px',
      },
    }, [
      h('span', { key: 'dot', style: { color: changedList.length > 0 ? COLOR.warn : COLOR.ok } }, changedList.length > 0 ? '●' : '●'),
      h('span', { key: 'scan' }, '目录扫描于 ' + scanTime),
      changedList.length > 0
        ? h('span', { key: 'chg', style: { color: COLOR.warn } }, '· ' + changedList.length + ' 个技能文件刚有变化：' + changedList.join('、'))
        : h('span', { key: 'ok' }, '· 无变化'),
      h('span', { key: 'eff', style: { color: COLOR.muted } }, '· 技能文件改动下一轮对话生效（无需重启）；插件自身更新需重启 DSH'),
      h('div', { key: 'sp', style: { flex: 1 } }),
      h('button', {
        key: 'refresh',
        onClick: function () {
          fetchState(sessionId, true).then(function (d) { if (d && d.ok) setData(d) }).catch(function () {})
        },
        style: { fontSize: '11px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', background: 'transparent', border: '1px solid ' + COLOR.line, color: 'inherit', fontFamily: 'inherit' },
      }, '立即刷新'),
    ])

    var rows = []
    var seenGroups = {}
    skills.forEach(function (s) {
      if (s.group) {
        if (seenGroups[s.group] === true) return
        seenGroups[s.group] = true
        var members = skills.filter(function (x) { return x.group === s.group })
        var meta = (data && data.groups ? data.groups : []).filter(function (g) { return g.id === s.group })[0]
        var groupLabel = meta ? meta.label : s.group
        var totalTokens = members.reduce(function (a, m) { return a + (m.tokens || 0) }, 0)
        var pinnedCount = members.filter(function (m) { return m.pinned }).length
        var isOpen = expanded[s.group] === true
        var head = h('div', {
          key: 'gh-' + s.group,
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 4px', flexWrap: 'wrap' },
        }, [
          h('button', {
            key: 'tog',
            onClick: function () { var n = Object.assign({}, expanded); n[s.group] = !isOpen; setExpanded(n) },
            style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: '12px', padding: '0 2px' },
          }, isOpen ? '▾' : '▸'),
          h('span', { key: 'lbl', style: { fontSize: '13px', fontWeight: 600 } }, groupLabel),
          (meta && meta.builtin === false) ? h('span', { key: 'cb' }, badge('自定义', COLOR.ok, false)) : null,
          h('span', { key: 'cnt' }, badge(members.length + ' 个技能', COLOR.muted, false)),
          pinnedCount > 0 ? h('span', { key: 'pin' }, badge('已固定 ' + pinnedCount, COLOR.info, false)) : null,
          h('div', { key: 'sp', style: { flex: 1 } }),
          h('span', { key: 'size', style: { fontSize: '11px', color: COLOR.muted } }, fmtTokens(totalTokens) + ' tok'),
          mode === 'manual' ? h('button', {
            key: 'ga',
            onClick: function () { act('/group', { groupId: s.group, action: 'allow' }) },
            style: buttonStyle(false, busy === '/group'),
          }, '整组放行') : null,
          h('button', {
            key: 'gp',
            onClick: function () { act('/group', { groupId: s.group, action: 'pin' }) },
            style: buttonStyle(false, busy === '/group'),
          }, '整组固定'),
          pinnedCount > 0 ? h('button', {
            key: 'gu',
            onClick: function () { act('/group', { groupId: s.group, action: 'unpin' }) },
            style: buttonStyle(false, busy === '/group'),
          }, '整组取消') : null,
          (meta && meta.builtin === false) ? h('button', {
            key: 'gd',
            onClick: function () {
              post('/groups/delete', { id: s.group })
                .then(function () { return fetchState(sessionId) })
                .then(function (d) { if (d && d.ok) setData(d) })
            },
            style: buttonStyle(false, false),
          }, '删除组') : null,
        ])
        var children = isOpen ? members.map(function (m) { return renderSkill(m, true) }) : []
        rows.push(h('div', {
          key: 'g-' + s.group,
          style: { borderBottom: '1px solid ' + COLOR.line, background: 'rgba(127,127,127,0.05)' },
        }, [head].concat(children)))
        return
      }
      rows.push(renderSkill(s, false))
    })

    if (skills.length === 0) {
      rows = [h('div', { key: 'empty', style: { padding: '16px 4px', color: COLOR.muted, fontSize: '13px' } }, '本会话没有可见技能。')]
    }

    return h('div', { style: { padding: '14px 18px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' } }, [
      h('div', { key: 'title', style: { fontSize: '14px', fontWeight: 600, marginBottom: '10px' } }, '技能加载控制'),
      error ? h('div', { key: 'err', style: { color: '#f85149', fontSize: '12px', marginBottom: '8px' } }, error) : null,
      modeBar,
      namingBar,
      summary,
      statusBar,
      restoreLine,
      h('div', { key: 'list' }, rows),
      h('div', { key: 'hint', style: { marginTop: '12px', fontSize: '11px', color: COLOR.muted, lineHeight: '17px' } },
        '渐进披露：技能目录只给模型名字和描述，正文要点开才读。手动模式下，模型尝试读未放行的技能会被拦下并显示「待授权」。勾选后点「加载所选」可把技能固定到本会话：注入一次正文，压缩后自动降级为要点摘要；自动恢复两次用尽后需要你点「重新注入」。'),
    ])
  }

  var apply = function (ctx) {
    ctx.inject(['slots'], function (scope) {
      scope.slots.inject('conversation.view', function () {
        return scope.slots.register({
          name: 'conversation.view',
          id: 'skill-gate',
          order: 30,
          label: function () { return '技能' },
          inject: function (sessionId) { return { sessionId: sessionId } },
        }, SkillGatePanel)
      })
    })
  }

  return { name: 'dsh-skill-gate', inject: ['slots'], apply: apply }
}})