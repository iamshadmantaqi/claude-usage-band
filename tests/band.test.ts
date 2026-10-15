import { test, expect, mock } from 'claude-code/testing'

import { duration, money, tokens } from '../hooks/register'

// 15 October 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 15, 12, 0)
const LIMITS = [
  // 28% used, 3h of 5h gone (60%): behind pace, calm.
  { kind: 'five_hour', percentUsed: 28, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
  // 7% used with 4 days left.
  { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(NOW + 4 * 86_400_000 + 4 * 3_600_000).toISOString() },
]
const CONTEXT = { tokens: 281_000, window: 1_000_000, percent: 28 }
const BREAKDOWN = { rawMaxTokens: 400_000, maxTokens: 400_000, totalTokens: 281_000, autocompactSource: 'settings', isAutoCompactEnabled: true, autoCompactThreshold: 387_000, percentage: 70 }

type World = { breakdown?: object | null; env?: Record<string, string>; limits?: unknown[]; agents?: unknown[]; cost?: number }

function world(on: any, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  mock.env(on, w.env ?? {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd ?? '/tmp' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('agent.list', () => ({ value: w.agents ?? [] }))
  on('session.usage', (_$: any, e: any) => {
    const context: any = { ...CONTEXT }
    if (e?.breakdown && w.breakdown !== null) context.breakdown = w.breakdown ?? BREAKDOWN
    return { value: { startedAt: NOW, context, rateLimits: w.limits ?? LIMITS, cost: { usd: w.cost ?? 190.84 } } }
  })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  return clock as any
}

async function band($: any, surface: 'terminal' | 'desktop', columns = 200) {
  const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { bodyColumns: columns, hasSurvey: false, isWorking: false, maxRows: 10 } as any })
  const texts = ((await ui.findAll({ type: 'Text' })) as any[]).map((t) => String(t.text).trim())
  return { ui, texts, all: texts.join(' ') }
}

test('context reads the auto-compact window, not the model window', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  for (const surface of ['desktop', 'terminal'] as const) {
    const { texts, all } = await band($, surface)
    expect(texts).toContain('281k')
    expect(texts).toContain('/ 400k')
    expect(texts).not.toContain('/ 1M')
  }
  const { all } = await band($, 'desktop')
  // The hover card names the source and the threshold.
  expect(all).toContain('Context 281k of 400k (70%)')
  expect(all).toContain('from your settings')
  expect(all).toContain('Auto-compacts at about 387k')
})

test('falls back to CLAUDE_CODE_AUTO_COMPACT_WINDOW without a breakdown', async ($, on) => {
  world(on, { breakdown: null, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' } })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { all } = await band($, 'desktop')
  expect(all).toContain('/ 500k')
})

test('the model window when nothing smaller is set', async ($, on) => {
  world(on, { breakdown: { ...BREAKDOWN, rawMaxTokens: 1_000_000, autocompactSource: 'auto' } })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { all } = await band($, 'desktop')
  expect(all).toContain('/ 1M')
})

test('limits, time left and cost', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { texts } = await band($, 'desktop')
  expect(texts).toContain('5h')
  expect(texts).toContain('28%')
  expect(texts).toContain('2h 00m')
  expect(texts).toContain('7d')
  expect(texts).toContain('7%')
  expect(texts).toContain('4d 4h')
  expect(texts).toContain('$191')
})

test('a window that reset shows a dash, not a stale share', async ($, on) => {
  world(on, { limits: [{ kind: 'five_hour', percentUsed: 80, resetsAt: new Date(NOW - 60_000).toISOString() }] })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { texts } = await band($, 'terminal')
  expect(texts).toContain('–')
  expect(texts).not.toContain('80%')
})

test('the 7-day pace warning when the week would run out early', async ($, on) => {
  // 2 days gone and 60% used: at that pace 100% comes in about 1.3 days, before the reset.
  world(on, { limits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString() }] })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { all } = await band($, 'desktop')
  expect(all).toContain('out ')
  expect(all).toContain("At this week's pace it runs out")
})

test('agents running and seen', async ($, on) => {
  world(on, {
    agents: [
      { id: 'a1', type: 'Explore', description: 'Find the band', status: 'running' },
      { id: 'a2', type: 'general-purpose', description: 'Write tests', status: 'completed' },
    ],
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { texts, all } = await band($, 'desktop')
  expect(texts).toContain('1 running')
  expect(texts).toContain('/ 2')
  expect(all).toContain('Explore: Find the band')
})

test('no agents yet shows a muted 0', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const { texts } = await band($, 'desktop')
  expect(texts).toContain('0 agents')
})

test('terminal drops the details when narrow', async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const wide = await band($, 'terminal', 200)
  expect(wide.all).toContain('2h 00m')
  const narrow = await band($, 'terminal', 50)
  expect(narrow.all).not.toContain('2h 00m')
  expect(narrow.texts).toContain('28%')
})

test('formatting', async () => {
  expect(tokens(281_000)).toBe('281k')
  expect(tokens(9_800)).toBe('9.8k')
  expect(tokens(1_000_000)).toBe('1M')
  expect(duration(8 * 60_000)).toBe('8m')
  expect(duration(125 * 60_000)).toBe('2h 05m')
  expect(money(190.84, false)).toBe('$191')
  expect(money(190.84, true)).toBe('$190.84')
  expect(money(4.321, false)).toBe('$4.32')
})
