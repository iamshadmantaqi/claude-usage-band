import { test, expect, mock } from 'claude-code/testing'

import { hostSummary, loadTone, memoryTone, namesOf, parseStatus } from '../hooks/queue'

const STATUS = `slot 1: web/fix-x, run pid 101, 3 min, in /w/web/fix-x
slot 2: api/store, hold until 14:30, 12 min, in /w/api/store
remote slot 1 (box-a): lint-run, run pid 75176, 0 min, in /w/web/before
remote slot 2 (box-a): free
remote slot 3 (box-b): free
queue 1: api/orders, run pid 202, waiting 4 min, in /w/api/orders
queue 2: site/cart, hold pid 303, waiting 1 min, in /w/site/cart
memory free: 41%
memory pressure: warn
load:  12.50 9.10 8.00 
chats working (last 2 min): 7
gate: on, memory pressure warn, one heavy job at a time
remote (box-a, 2 slots): on, last check: ok (1 min ago)
  box-a: memory 3 of 9 GB used, agents account (with file cache) 3 GB, load 1.61 0.44 0.15, 1 jobs, 0 of them dev servers
remote (box-b, 1 slots): off, last check: unreachable (2 min ago)
  box-b: memory 6 of 46 GB used, agents account (with file cache) 16 GB, load 0.26 0.34 0.53, 2 jobs, 0 of them dev servers
`
const NOW = Date.UTC(2026, 9, 16, 8, 0)
const OPTIONS = { options: { queueScript: '~/tools/heavy.sh' } }

function world(on: any, store: Record<string, unknown> = {}) {
  const runs: string[][] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/x' })
  mock.store(on, store)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd ?? '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 1 } } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', (() => ({ value: undefined })) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv ?? e)
    const out = (e.argv ?? e)[0] === 'sysctl' ? '10\n' : STATUS
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  return runs
}

const texts = async (ui: any) => {
  const els = [...((await ui.findAll({ type: 'Text' })) as any[]), ...((await ui.findAll({ type: 'Button' })) as any[])]
  return els.map((t) => String(t.text ?? t.label ?? t.props?.label ?? '')).join(' | ')
}
const PANE = { component: 'Pane', requestId: 'job-queue', props: { bodyColumns: 48 } as any } as const
const BAND = { component: 'AbovePrompt', props: { bodyColumns: 160, hasSurvey: false, isWorking: false, maxRows: 10 } as any } as const

test('parses every line of the status output', async () => {
  const s = parseStatus(STATUS)
  expect(s.local.map((x) => x.label)).toEqual(['web/fix-x', 'api/store'])
  expect(s.local[1]?.kind).toBe('hold until 14:30')
  expect(s.remote.map((x) => [x.host, x.label])).toEqual([['box-a', 'lint-run'], ['box-a', null], ['box-b', null]])
  expect(s.queue.map((w) => [w.pos, w.label, w.kind, w.mins])).toEqual([[1, 'api/orders', 'run', 4], [2, 'site/cart', 'hold', 1]])
  expect([s.memoryFree, s.pressure, s.load, s.chats]).toEqual(['41%', 'warn', '12.50', '7'])
  expect(s.gateOn).toBe(true)
  expect(s.hosts.map((h) => [h.name, h.state])).toEqual([['box-a', 'on'], ['box-b', 'off']])
  expect(hostSummary(s.hosts[0]!.detail)).toBe('mem 3/9 GB · load 1.61')
  expect(parseStatus('gate: off (load limit 40, memory pressure limit normal)').loadLimit).toBe(40)
})

test('names, memory and load tones', async () => {
  expect(namesOf('/opt/tools/heavy.sh')).toEqual({ name: 'Heavy', command: 'heavy' })
  expect(namesOf('job_queue')).toEqual({ name: 'Job-queue', command: 'job-queue' })
  expect([memoryTone('normal'), memoryTone('warn'), memoryTone('critical')]).toEqual([undefined, 'warning', 'error'])
  expect([loadTone('2.67', 10, 40), loadTone('10', 10, 40), loadTone('40.1', 10, 40), loadTone('33', 8, null), loadTone('', 10, 40)]).toEqual([undefined, 'warning', 'error', 'error', undefined])
})

test('no row and no script runs without the option', async ($, on) => {
  const runs = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND } as any)
  expect(await texts(ui)).not.toContain('Heavy')
  expect(runs.length).toBe(0)
})

test('the row sits above the band on terminal and desktop', OPTIONS, async ($, on) => {
  const runs = world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(runs.some((argv) => argv[0] === '/Users/x/tools/heavy.sh' && argv[1] === 'status')).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND } as any)
    const all = await texts(ui)
    expect(all).toContain('Heavy  Mac 2/2 · box-a 1/2 · Queue 2')
    expect(all).toContain('box-b off')
    expect(all).toContain('2 waiting')
    expect(all).toContain('Mem 41% free')
    expect(all).toContain('Load 12.5')
    // The row comes first, the band beneath it.
    const tree = JSON.stringify(await ui.drawn())
    expect(tree.indexOf('queue-row')).toBeGreaterThan(-1)
    expect(tree.indexOf('queue-row')).toBeLessThan(tree.indexOf('1k'))
  }
})

test('the pane opens only a waiting queue, and a header opens its section', OPTIONS, async ($, on) => {
  world(on)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...PANE } as any)
    let all = await texts(ui)
    expect(all).toContain('box-a 1/2')
    expect(all).toContain('api/orders')
    expect(all).not.toContain('web/fix-x')
    await ui.press({ key: 'sec-mac' })
    expect(await texts(ui)).toContain('web/fix-x')
    await ui.press({ key: 'sec-host-box-b' })
    expect(await texts(ui)).toContain('last check: unreachable')
    // Sections are the session's, not the surface's: close both for the next pass.
    await ui.press({ key: 'sec-host-box-b' })
    await ui.press({ key: 'sec-mac' })
    all = await texts(ui)
    expect(all).not.toContain('web/fix-x')
  }
})

test('a fresh reading another session stored is used without running the script', OPTIONS, async ($, on) => {
  const runs = world(on, { 'queue-reading': { at: NOW - 1_000, snapshot: parseStatus(STATUS), error: null } })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND } as any)
  expect(await texts(ui)).toContain('Queue 2')
  expect(runs.filter((argv) => argv[1] === 'status').length).toBe(0)
})
