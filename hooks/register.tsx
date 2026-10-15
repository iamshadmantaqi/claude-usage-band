// Usage Band: one bar above the prompt.
//
//   Desktop:  ◔ 281k / 400k +9.8k   5h ▬▬▭▭ 28% 8m   7d ▬▭▭▭ 7% 4d 4h   ⚡ 59m   $191   ● 5 running / 38
//   Terminal: ◔ 281k/400k +9.8k │ 5h ━━──── 28% 8m │ 7d ━───── 7% 4d 4h │ cache 59m │ $191 │ 5 running / 38
//
// Colour only carries state: blue while things are fine, amber when ahead of pace or running
// short, red at the edge. Every segment has a hover card in the app with the detail.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { CacheHit, Context, RunningAgent, View } from '../types'

type $ = EngineInterface

const EMPTY: View = { context: null, limits: { at: 0, list: [] }, cost: null, lastPromptCost: null, cache: null, running: [], seen: [] }
const view = atom({ plugin: 'usage-band', key: 'view' } as const, EMPTY)

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const SPANS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
// The account's limits are shared by every session: the newest reading lives in the store.
const LIMITS_KEY = 'limits'
// The compaction window rarely changes; the breakdown that reports it is read this often at most.
const WINDOW_TTL = 5 * MIN
const RUNNING = new Set(['pending', 'running', 'waiting'])

type Tone = 'ok' | 'warn' | 'alert'
// SVG fills, readable on light and dark backgrounds.
const FILL: Record<Tone, string> = { ok: '#3f8cff', warn: '#e09b2d', alert: '#e5534b' }
// Text colours, as theme keys where the theme has one.
const INK: Record<Tone, string | undefined> = { ok: undefined, warn: 'warning', alert: 'error' }
const TRACK = 'rgba(127,127,127,0.28)'
const MARK = 'rgba(127,127,127,0.95)'
const MUTED_ICON = '#8b95a5'

// Not drawn from, so module variables: they start over on a reload, as session.start does.
let windowReadAt = 0
let costAtSubmit: number | null = null
let tokensAtSubmit: number | null = null
let cachingOff = false
let timer: { cancel: () => void } | null = null

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    timer?.cancel()
    windowReadAt = 0
    cachingOff = Boolean(await $.env.get('DISABLE_PROMPT_CACHING'))
    const usage = await $.session.usage()
    const context = await contextOf($, usage.context, null)
    const limits = await newestLimits($, usage.rateLimits)
    await update($, view, (v) => ({ ...(v ?? EMPTY), context: context ?? v?.context ?? null, limits, cost: usage.cost?.usd ?? v?.cost ?? null }))
    await refreshAgents($)
    // Time moves on (cache countdown, reset clocks) and other sessions read newer limits.
    timer = $.clock.every(15_000, async () => {
      await adoptSharedLimits($)
      await refreshAgents($)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'prompt_input_exit' || e.reason === 'other') timer?.cancel()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const v = await read($, view)
    costAtSubmit = v?.cost ?? null
    tokensAtSubmit = v?.context?.tokens ?? null
    return next(e)
  })

  // Each main-loop request: how much of its prompt the cache served. The cache's lifetime runs
  // from the request's start.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const at = await $.clock.now()
    const result = yield* next(e)
    const u = result?.usage
    if (u) {
      const cache: CacheHit = { at, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, fresh: u.input_tokens ?? 0 }
      await update($, view, (v) => ({ ...(v ?? EMPTY), cache }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      await refreshAgents($)
      return result
    }
    try {
      const usage = await $.session.usage()
      const prev = await read($, view)
      const context = await contextOf($, usage.context, prev?.context ?? null)
      const cost = usage.cost?.usd ?? prev?.cost ?? null
      const lastPromptCost = cost !== null && costAtSubmit !== null && cost >= costAtSubmit ? cost - costAtSubmit : prev?.lastPromptCost ?? null
      if (context && tokensAtSubmit !== null) context.delta = context.tokens - tokensAtSubmit
      const limits = usage.rateLimits.length > 0 ? await shareLimits($, usage.rateLimits) : prev?.limits ?? EMPTY.limits
      await update($, view, (v) => ({ ...(v ?? EMPTY), context: context ?? v?.context ?? null, cost, lastPromptCost, limits }))
      await refreshAgents($)
    } catch {
      // No reading this turn: the bar keeps the last one.
    }
    return result
  })

  // A compaction drops the context at once; the next request writes a new cache.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.trigger === 'precompute' || !result || 'skip' in result) return result
    try {
      windowReadAt = 0
      const prev = await read($, view)
      const usage = await $.session.usage()
      const context = await contextOf($, usage.context, prev?.context ?? null)
      const after = (result as { tokensAfter?: number }).tokensAfter
      if (context && typeof after === 'number' && after > 0) context.tokens = after
      if (context) context.delta = null
      await update($, view, (v) => ({ ...(v ?? EMPTY), context: context ?? v?.context ?? null, cache: null }))
    } catch {
      // The bar catches up at the end of the next prompt.
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const limits = e.changed.includes('rateLimits') && e.rateLimits.length > 0 ? await shareLimits($, e.rateLimits) : null
    await update($, view, (v) => {
      const base = v ?? EMPTY
      const out: View = { ...base }
      if (limits) out.limits = limits
      if (e.cost) out.cost = e.cost.usd
      if (e.changed.includes('context') && base.context && typeof e.context.tokens === 'number') {
        out.context = { ...base.context, tokens: e.context.tokens, modelWindow: e.context.window || base.context.modelWindow }
      }
      return out
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      await refreshAgents($)
    } catch {}
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = (await read($, view)) ?? EMPTY
    if (!v.context && v.limits.list.length === 0) return next(e)
    const now = await $.clock.now()
    const segments = segmentsOf(v, now)
    const els = $.ui.resolve(e)
    const mine = e.surface === 'terminal' || !('Svg' in els) ? drawTerminal(els, segments, e.props.bodyColumns ?? 80) : drawDesktop(els, segments)
    const below = await next(e)
    if (!below) return mine
    const { Box } = els
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}

// ---------- Readings ----------

// The context against the auto-compact window. The engine's /context breakdown names that window
// (`rawMaxTokens`): the model's own limit, or the smaller one settings, the environment or the
// account set. Read at most every few minutes; between reads the last one stands.
async function contextOf($: $, live: { tokens?: number; window: number }, prev: Context | null): Promise<Context | null> {
  if (!live || !(live.window > 0)) return prev ? { ...prev } : null
  const tokens = typeof live.tokens === 'number' ? live.tokens : prev?.tokens ?? 0
  let win = prev && prev.modelWindow === live.window ? { window: prev.window, source: prev.source, threshold: prev.threshold } : null
  const now = await $.clock.now()
  if (!win || now - windowReadAt > WINDOW_TTL) win = (await compactWindow($, live.window, now)) ?? win
  if (!win) win = { window: live.window, source: 'model', threshold: null }
  return { tokens, modelWindow: live.window, window: win.window, source: win.source, threshold: win.threshold, delta: prev?.delta ?? null }
}

async function compactWindow($: $, modelWindow: number, now: number) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (b && b.rawMaxTokens > 0) {
      windowReadAt = now
      const threshold = b.isAutoCompactEnabled && typeof b.autoCompactThreshold === 'number' ? b.autoCompactThreshold : null
      return { window: b.rawMaxTokens, source: String(b.autocompactSource ?? 'auto'), threshold }
    }
  } catch {
    // No session bound yet, or the breakdown failed: the variable below, then the model's window.
  }
  const fromEnv = Number(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  if (fromEnv > 0) return { window: Math.min(fromEnv, modelWindow), source: 'env', threshold: null }
  return null
}

function sortLimits(list: readonly SessionRateLimit[]) {
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind))
}

// This session's reading, published when it is the newest the store knows.
async function shareLimits($: $, list: readonly SessionRateLimit[]) {
  const limits = { at: await $.clock.now(), list: sortLimits(list) }
  try {
    const stored = (await $.store.get(LIMITS_KEY)) as View['limits'] | undefined
    if (!stored || !(stored.at > limits.at)) await $.store.set(LIMITS_KEY, limits)
  } catch {}
  return limits
}

// At start: the newest of this session's reading and the store's.
async function newestLimits($: $, list: readonly SessionRateLimit[]) {
  let stored: View['limits'] | undefined
  try {
    stored = (await $.store.get(LIMITS_KEY)) as View['limits'] | undefined
  } catch {}
  if (stored && Array.isArray(stored.list) && stored.list.length > 0) return { at: stored.at, list: sortLimits(stored.list) }
  return list.length > 0 ? shareLimits($, list) : EMPTY.limits
}

async function adoptSharedLimits($: $) {
  try {
    const stored = (await $.store.get(LIMITS_KEY)) as View['limits'] | undefined
    const v = await read($, view)
    if (stored && Array.isArray(stored.list) && stored.at > (v?.limits.at ?? 0)) {
      await update($, view, (x) => ({ ...(x ?? EMPTY), limits: { at: stored.at, list: sortLimits(stored.list) } }))
    }
  } catch {}
}

async function refreshAgents($: $) {
  let list: Awaited<ReturnType<$['agent']['list']>>
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const running: RunningAgent[] = list.filter((a) => RUNNING.has(a.status)).map((a) => ({ id: a.id, type: a.type, description: a.description }))
  const v = (await read($, view)) ?? EMPTY
  const seen = [...new Set([...v.seen, ...list.map((a) => a.id)])]
  const same = seen.length === v.seen.length && running.length === v.running.length && running.every((r, i) => r.id === v.running[i]?.id)
  if (!same) await update($, view, (x) => ({ ...(x ?? EMPTY), running, seen }))
}

// ---------- What each segment says ----------

type Part = { text: string; tone?: Tone; strong?: boolean; dim?: boolean; detail?: boolean }
type Segment = {
  key: string
  icon?: { svg: string; alt: string; glyph: string; tone?: Tone }
  bar?: { used: number; mark: number | null; tone: Tone }
  parts: Part[]
  card: string[]
}

function segmentsOf(v: View, now: number): Segment[] {
  const out: Segment[] = []
  if (v.context) out.push(contextSegment(v.context))
  for (const l of v.limits.list) out.push(limitSegment(l, now))
  const cache = cacheSegment(v, now)
  if (cache) out.push(cache)
  if (v.cost !== null && v.cost >= 0.005) out.push(costSegment(v))
  out.push(agentsSegment(v))
  return out
}

function contextSegment(c: Context): Segment {
  const pct = c.window > 0 ? (c.tokens / c.window) * 100 : 0
  const tone: Tone = pct >= 85 ? 'alert' : pct >= 60 ? 'warn' : 'ok'
  const parts: Part[] = [{ text: tokens(c.tokens), strong: true, tone: tone === 'ok' ? undefined : tone }, { text: `/ ${tokens(c.window)}`, dim: true }]
  if (c.delta !== null && Math.abs(c.delta) >= 1000) parts.push({ text: c.delta > 0 ? `+${tokens(c.delta)}` : `−${tokens(-c.delta)}`, dim: true, detail: true })
  const card = [`Context ${tokens(c.tokens)} of ${tokens(c.window)} (${Math.round(pct)}%)`]
  if (c.window < c.modelWindow) card.push(`  Auto-compact window ${tokens(c.window)}, ${SOURCES[c.source] ?? c.source}; model allows ${tokens(c.modelWindow)}`)
  else card.push(`  The model's full window`)
  if (c.threshold !== null) card.push(`Auto-compacts at about ${tokens(c.threshold)}`, `  ${tokens(Math.max(0, c.threshold - c.tokens))} to go`)
  if (c.delta !== null) card.push(`Last prompt ${c.delta >= 0 ? '+' : '−'}${tokens(Math.abs(c.delta))}`)
  return { key: 'context', icon: { svg: ringSvg(pct, FILL[tone]), alt: `Context ${Math.round(pct)}% of the auto-compact window`, glyph: ringGlyph(pct), tone }, parts, card }
}

const SOURCES: Record<string, string> = {
  settings: 'from your settings',
  env: 'from CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  clientdata: 'set by your account',
  experiment: 'set by an experiment',
  'model-default': "the model's default",
  'unknown-model': 'a default for this model',
}

function limitSegment(l: SessionRateLimit, now: number): Segment {
  const label = LABELS[l.kind] ?? l.kind
  const reset = Date.parse(l.resetsAt ?? '')
  const left = Number.isFinite(reset) ? reset - now : null
  const span = SPANS[l.kind]
  // A window that already reset: its reading says nothing until the next response.
  if (left !== null && left <= 0) {
    return { key: 'limit-' + l.kind, parts: [{ text: label, dim: true }, { text: '–', dim: true }], card: [`${NAMES[l.kind] ?? label} reset at ${clock(reset)}`, '  The next message brings a new reading'] }
  }
  const used = clamp(l.percentUsed)
  const elapsed = span && left !== null ? clamp(((span - left) / span) * 100) : null
  const ahead = elapsed === null ? 0 : used - elapsed
  const tone: Tone = used >= 90 || ahead > 20 ? 'alert' : ahead > 5 ? 'warn' : 'ok'
  const parts: Part[] = [{ text: label, dim: true }, { text: `${Math.round(used)}%`, strong: true, tone: tone === 'ok' ? undefined : tone }]
  if (left !== null) parts.push({ text: duration(left), dim: true, detail: true })
  const card = [`${NAMES[l.kind] ?? label}: ${Math.round(used)}% used`]
  if (elapsed !== null) card.push(`  ${Math.round(elapsed)}% of the window has passed${ahead > 0 ? `, ${Math.round(ahead)} points ahead of pace` : ''}`)
  if (left !== null) card.push(`Resets ${l.kind === 'five_hour' ? 'at ' + clock(reset) : dayTime(reset)}`, `  in ${duration(left)}`)
  // The week's average pace so far, projected: shown after a day and from 15% used.
  if (l.kind === 'seven_day' && span && left !== null && span - left >= DAY && used >= 15 && used < 100) {
    const out = now + ((100 - used) * (span - left)) / used
    if (out < reset) {
      parts.push({ text: `out ${weekday(out)}`, tone: out - now < DAY ? 'alert' : 'warn', strong: true })
      card.push(`At this week's pace it runs out ${dayTime(out)}`, `  before the reset; an estimate`)
    }
  }
  return { key: 'limit-' + l.kind, bar: { used, mark: elapsed, tone }, parts, card }
}

const NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit', spend_limit: 'Spend limit' }

// The prompt cache keeps the conversation's start for an hour on a subscription, five minutes on
// an API key; each request that reads it starts the time again.
function cacheSegment(v: View, now: number): Segment | null {
  if (cachingOff || !v.cache) return null
  const ttl = v.limits.list.length > 0 ? HOUR : 5 * MIN
  const left = ttl - (now - v.cache.at)
  const total = v.cache.read + v.cache.write + v.cache.fresh
  const hit = total > 0 ? Math.round((v.cache.read / total) * 100) : 0
  const card: string[] = []
  let parts: Part[]
  let tone: Tone
  if (left > 0) {
    tone = left < ttl / 5 ? 'warn' : 'ok'
    parts = [{ text: duration(left), strong: tone !== 'ok', tone: tone === 'ok' ? undefined : tone }]
    card.push(`Prompt cache warm until ${clock(v.cache.at + ttl)}`, `  ${duration(left)} left, ${ttl === HOUR ? '1 hour' : '5 minute'} lifetime`)
  } else {
    tone = 'alert'
    parts = [{ text: 'cold', strong: true, tone }]
    card.push(`Prompt cache expired ${duration(-left)} ago`)
    if (v.context) card.push(`  The next message writes about ${tokens(v.context.tokens)} again`)
    if (v.context && v.context.tokens >= 100_000) card.push(`/compact first makes that rewrite smaller`)
  }
  if (total > 0) card.push(`Last message: ${hit}% read from the cache`, `  ${tokens(v.cache.read)} read, ${tokens(v.cache.write)} written`)
  return { key: 'cache', icon: { svg: boltSvg(tone === 'ok' ? MUTED_ICON : FILL[tone]), alt: 'Prompt cache', glyph: 'cache', tone }, parts, card }
}

function costSegment(v: View): Segment {
  const cost = v.cost ?? 0
  const card = [`Session ${money(cost, true)} at API prices`]
  if (v.limits.list.length > 0) card.push('  On a plan this counts toward its limits, not a bill')
  if (v.lastPromptCost !== null && v.lastPromptCost >= 0.005) card.push(`Last prompt +${money(v.lastPromptCost, true)}`)
  return { key: 'cost', parts: [{ text: money(cost, false) }], card }
}

// Always drawn: a session that has run no agent shows a muted 0.
function agentsSegment(v: View): Segment {
  const n = v.running.length
  const total = v.seen.length
  const card = [`${total} agent${total === 1 ? '' : 's'} this session, ${n} running`]
  for (const a of v.running.slice(0, 8)) card.push(`  ${a.type}: ${fit(a.description || 'working', 48)}`)
  if (n > 8) card.push(`  and ${n - 8} more`)
  const parts: Part[] = n > 0 ? [{ text: `${n} running`, strong: true }, { text: `/ ${total}`, dim: true }] : [{ text: `${total} agent${total === 1 ? '' : 's'}`, dim: true }]
  return { key: 'agents', icon: n > 0 ? { svg: dotSvg(FILL.ok), alt: 'Agents running', glyph: '●', tone: 'ok' } : undefined, parts, card }
}

// ---------- Drawing ----------

type Els = ReturnType<$['ui']['resolve']>

function drawDesktop(els: Els, segments: Segment[]) {
  const { Box, Text } = els
  const Svg = (els as { Svg?: any }).Svg
  const half = Math.ceil(segments.length / 2)
  return (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={0} paddingX={1}>
      {segments.map((s, i) => (
        <Box key={s.key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0} paddingX={1} hover={{ backgroundColor: 'rgba(127,127,127,0.14)' }}>
          {s.icon ? <Svg key="icon" source={s.icon.svg} alt={s.icon.alt} width={14} height={14} /> : null}
          {partsOf(Text, s.parts.slice(0, s.bar ? 1 : s.parts.length))}
          {s.bar ? <Svg key="bar" source={barSvg(s.bar.used, s.bar.mark, FILL[s.bar.tone])} alt={`${Math.round(s.bar.used)}% used`} width={BAR.w} height={BAR.h} /> : null}
          {s.bar ? partsOf(Text, s.parts.slice(1), 'p') : null}
          {card(els, s.card, i >= half)}
        </Box>
      ))}
    </Box>
  )
}

function partsOf(Text: Els['Text'], parts: Part[], prefix = 't') {
  return parts.map((p, i) => (
    <Text key={prefix + i} bold={p.strong} dimColor={p.dim && !p.tone} color={p.tone ? INK[p.tone] : undefined}>
      {p.text}
    </Text>
  ))
}

// Hidden until the pointer is over its segment; drawn above the bar, anchored to the segment's
// left edge, or its right edge for segments in the bar's right half.
function card(els: Els, lines: string[], fromRight: boolean) {
  const { Box, Text } = els
  if (lines.length === 0) return null
  return (
    <Box position="absolute" bottom={1} {...(fromRight ? { right: 0 } : { left: 0 })} display="none" hover={{ display: 'flex' }} flexDirection="column" paddingX={1} borderStyle="round" borderColor="subtle" backgroundColor="background">
      {lines.map((line, i) =>
        line.startsWith('  ') ? (
          <Text key={'c' + i} dimColor>
            {line.trim()}
          </Text>
        ) : (
          <Text key={'c' + i} bold={i === 0}>
            {line}
          </Text>
        ),
      )}
    </Box>
  )
}

const TEXT_BAR = 6

function drawTerminal(els: Els, segments: Segment[], columns: number) {
  const { Box, Text } = els
  // Too wide for the terminal: the details go first, then the bars.
  const width = (withDetail: boolean, withBar: boolean) =>
    segments.reduce((n, s) => n + segmentWidth(s, withDetail, withBar), 0) + 3 * Math.max(0, segments.length - 1) + 2
  const withDetail = width(true, true) <= columns
  const withBar = withDetail || width(false, true) <= columns
  const children: RenderChildren[] = []
  segments.forEach((s, i) => {
    if (i > 0) children.push(<Text key={'sep' + i} dimColor>{' │ '}</Text>)
    const parts = s.parts.filter((p) => withDetail || !p.detail)
    const inner: RenderChildren[] = []
    if (s.icon) inner.push(<Text key="icon" color={glyphInk(s)} dimColor={!glyphInk(s)}>{s.icon.glyph + ' '}</Text>)
    const head = s.bar ? parts.slice(0, 1) : parts
    head.forEach((p, j) => inner.push(textPart(Text, p, 'h' + j, j > 0)))
    if (s.bar && withBar) inner.push(textBar(Text, s.bar))
    if (s.bar) parts.slice(1).forEach((p, j) => inner.push(textPart(Text, p, 'b' + j, true)))
    children.push(
      <Box key={s.key} flexDirection="row">
        {inner}
      </Box>,
    )
  })
  return (
    <Box flexDirection="row" paddingX={1}>
      {children}
    </Box>
  )
}

// The terminal's icon colour: the state's when it is not fine; blue context, green agents.
function glyphInk(s: Segment) {
  const tone = s.icon?.tone
  if (tone && tone !== 'ok') return INK[tone]
  return s.key === 'context' ? 'blue' : s.key === 'agents' ? 'success' : undefined
}

function textPart(Text: Els['Text'], p: Part, key: string, space: boolean) {
  return (
    <Text key={key} bold={p.strong} dimColor={p.dim && !p.tone} color={p.tone ? INK[p.tone] ?? (p.tone === 'ok' ? 'blue' : undefined) : undefined}>
      {(space ? ' ' : '') + p.text}
    </Text>
  )
}

function textBar(Text: Els['Text'], bar: NonNullable<Segment['bar']>) {
  // Any share above zero shows at least one cell.
  const filled = bar.used > 0 ? Math.max(1, Math.round((bar.used / 100) * TEXT_BAR)) : 0
  return (
    <Text key="bar">
      {' '}
      <Text color={bar.tone === 'ok' ? 'blue' : INK[bar.tone]}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(TEXT_BAR - filled)}</Text>
    </Text>
  )
}

function segmentWidth(s: Segment, withDetail: boolean, withBar: boolean) {
  const parts = s.parts.filter((p) => withDetail || !p.detail)
  return (s.icon ? [...s.icon.glyph].length + 1 : 0) + parts.reduce((n, p) => n + [...p.text].length + 1, 0) + (s.bar && withBar ? TEXT_BAR + 1 : 0)
}

// ---------- Pictures ----------

const BAR = { w: 40, h: 10 }

// A rounded bar filled to the share used, with a tick where the clock stands in the window.
function barSvg(used: number, mark: number | null, color: string) {
  const { w, h } = BAR
  const y = 2
  const th = h - 4
  const fill = Math.max(used > 0 ? th : 0, (used / 100) * w)
  let body = `<rect x="0" y="${y}" width="${w}" height="${th}" rx="${th / 2}" fill="${TRACK}"/>`
  if (fill > 0) body += `<rect x="0" y="${y}" width="${fill.toFixed(1)}" height="${th}" rx="${th / 2}" fill="${color}"/>`
  if (mark !== null) {
    const x = Math.min(w - 1, Math.max(1, (mark / 100) * w))
    body += `<rect x="${(x - 0.75).toFixed(2)}" y="0" width="1.5" height="${h}" rx="0.75" fill="${MARK}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
}

// A ring filled clockwise to the share of the window in use.
function ringSvg(pct: number, color: string) {
  const r = 5.5
  const c = 2 * Math.PI * r
  const len = (clamp(pct) / 100) * c
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">` +
    `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${TRACK}" stroke-width="2.4"/>` +
    `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/></svg>`
  )
}

function boltSvg(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path d="M8 1 2.5 8H7l-1 5 5.5-7H7z" fill="${color}" stroke="${color}" stroke-width="0.8" stroke-linejoin="round"/></svg>`
}

function dotSvg(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="${color}" fill-opacity="0.22"/><circle cx="7" cy="7" r="3" fill="${color}"/></svg>`
}

function ringGlyph(pct: number) {
  return pct < 12.5 ? '○' : pct < 37.5 ? '◔' : pct < 62.5 ? '◑' : pct < 87.5 ? '◕' : '●'
}

// ---------- Formatting ----------

function clamp(n: number) {
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0))
}

// 1M, 1.2M, 281k, 9.8k, 950.
export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

// 8m, 2h 05m, 4d 4h.
export function duration(ms: number) {
  const m = Math.max(0, Math.round(ms / MIN))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

// $4.32 in the bar, $191 from a hundred; the card keeps the cents.
export function money(usd: number, exact: boolean) {
  if (usd < 0.01) return '< $0.01'
  if (!exact && usd >= 100) return `$${Math.round(usd)}`
  return `$${usd.toFixed(2)}`
}

function fmt(ms: number, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hourCycle: 'h23', ...opts }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC'
  }
}

const clock = (ms: number) => fmt(ms, { hour: '2-digit', minute: '2-digit' })
const weekday = (ms: number) => fmt(ms, { weekday: 'short' })
const dayTime = (ms: number) => fmt(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function fit(text: string, n: number) {
  const c = [...text]
  return c.length > n ? c.slice(0, n - 1).join('') + '…' : text
}
