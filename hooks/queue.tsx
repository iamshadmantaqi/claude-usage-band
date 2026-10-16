// The job queue row: an optional line above the band, and a side pane, for a machine that runs heavy
// jobs through a queue script. Set the `queueScript` option to the script's path; the row stays off
// while it is empty. The script's `status` output is read as these lines:
//
//   slot 1: free                                    slot 2: <label>, run pid 123, 3 min, in <dir>
//   remote slot 1 (<host>): free                    remote slot 2 (<host>): <label>, run pid 9, 0 min, in <dir>
//   queue 1: <label>, run pid 77, waiting 4 min, in <dir>
//   memory free: 79%   memory pressure: normal   load: 2.67 2.35 2.13   chats working (last 2 min): 2
//   gate: off (load limit 40, ...)                  remote (<host>, 3 slots): on, last check: ok (1 min ago)
//     <host>: memory 3 of 9 GB used, ..., load 1.61 0.44 0.15, ...
//
// The row (drawn by register.tsx):  ◇ Heavy  Mac 0/2 · <host> 1/3 · Queue 0 · Mem 79% free  Load 2.7   (click: the pane)
// Its label and its slash command come from the script's file name (heavy.sh: "Heavy", /heavy).

import type { QueueHost, QueueSnapshot, QueueSlot } from '../types'

// heavy.sh -> { name: 'Heavy', command: 'heavy' }
export function namesOf(path: string) {
  const base = (path.split('/').pop() ?? '').replace(/\.[^.]*$/, '')
  const command = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'queue'
  return { name: command.charAt(0).toUpperCase() + command.slice(1), command }
}

const mins = (s: string) => Number(s) || 0

export function parseStatus(text: string): QueueSnapshot {
  const snap: QueueSnapshot = { local: [], remote: [], queue: [], memoryFree: '', pressure: '', load: '', loadLimit: null, chats: '', gate: '', gateOn: false, hosts: [] }
  let host: QueueHost | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    // Each line's groups as strings, '' where a group did not take part.
    const match = (re: RegExp) => {
      const m = line.match(re)
      return m ? Array.from(m, (x) => x ?? '') : null
    }
    let m: string[] | null
    if ((m = match(/^slot (\d+): free$/))) {
      snap.local.push({ n: Number(m[1]), host: null, label: null, kind: '', mins: 0, cwd: '' })
    } else if ((m = match(/^slot (\d+): (.+?), (hold until \S+|run pid \d+), (\d+) min, in (.*)$/))) {
      const [, n = '', label = '', kind = '', min = '', cwd = ''] = m
      snap.local.push({ n: Number(n), host: null, label, kind: kind.startsWith('hold') ? kind : 'run', mins: mins(min), cwd })
    } else if ((m = match(/^remote slot (\d+) \(([^)]+)\): free$/))) {
      snap.remote.push({ n: Number(m[1]), host: m[2] ?? '', label: null, kind: '', mins: 0, cwd: '' })
    } else if ((m = match(/^remote slot (\d+) \(([^)]+)\): (.+?), run pid \d+, (\d+) min, in (.*)$/))) {
      const [, n = '', where = '', label = '', min = '', cwd = ''] = m
      snap.remote.push({ n: Number(n), host: where, label, kind: 'run', mins: mins(min), cwd })
    } else if ((m = match(/^queue (\d+): (.+?), (\S+) pid \d+, waiting (\d+) min, in (.*)$/))) {
      const [, pos = '', label = '', kind = '', min = '', cwd = ''] = m
      snap.queue.push({ pos: Number(pos), label, kind, mins: mins(min), cwd })
    } else if ((m = match(/^memory free: (.*)$/))) {
      snap.memoryFree = (m[1] ?? '').trim()
    } else if ((m = match(/^memory pressure: (.*)$/))) {
      snap.pressure = (m[1] ?? '').trim()
    } else if ((m = match(/^load: (.*)$/))) {
      snap.load = (m[1] ?? '').trim().split(/\s+/)[0] ?? ''
    } else if ((m = match(/^chats working \(last 2 min\): (.*)$/))) {
      snap.chats = (m[1] ?? '').trim()
    } else if ((m = match(/^gate: (on|off)(?:, | )?(.*)$/))) {
      snap.gateOn = m[1] === 'on'
      snap.gate = snap.gateOn ? (m[2] ?? '') : 'off'
      const limit = (m[2] ?? '').match(/load limit (\d+(?:\.\d+)?)/)
      if (limit) snap.loadLimit = Number(limit[1])
    } else if ((m = match(/^remote \(([^,]+), (\d+) slots?\): (\w+)(?:, last check: (.*))?$/))) {
      const [, name = '', slots = '', state = '', check = ''] = m
      host = { name, slots: Number(slots), state, check, detail: '' }
      snap.hosts.push(host)
    } else if (host && (m = match(/^\s+([^:]+): (.*)$/)) && m[1] === host.name) {
      host.detail = m[2] ?? ''
    }
  }
  return snap
}

// "memory 3 of 9 GB used, agents account ..., load 1.61 0.44 0.15, 1 jobs, ..." to "mem 3/9 GB · load 1.61".
export function hostSummary(detail: string): string {
  const mem = detail.match(/memory (\d+) of (\d+) GB used/)
  const load = detail.match(/load ([\d.]+)/)
  return [mem ? `mem ${mem[1]}/${mem[2]} GB` : '', load ? `load ${load[1]}` : ''].filter(Boolean).join(' · ')
}

export const used = (slots: QueueSlot[]) => slots.filter((s) => s.label).length

// One count per machine, in the order the script lists its slots. A host it reports as anything
// but on is marked off: its slots take no jobs.
export function summary(s: QueueSnapshot) {
  const states = new Map(s.hosts.map((x) => [x.name, x.state]))
  const names = [...new Set(s.remote.map((x) => x.host ?? ''))]
  const hosts = names.map((name) => {
    const slots = s.remote.filter((x) => (x.host ?? '') === name)
    return { name, count: `${used(slots)}/${slots.length}`, isOn: (states.get(name) ?? 'on') === 'on' }
  })
  return { mac: `${used(s.local)}/${s.local.length}`, hosts, queue: s.queue.length }
}

// Memory reads by macOS memory pressure, not the free figure: free memory stays low while the cache is full.
export function memoryTone(pressure: string): 'warning' | 'error' | undefined {
  return pressure === 'critical' ? 'error' : pressure === 'warn' ? 'warning' : undefined
}

// Amber once the load passes the core count, red at the script's own load limit (four per core when
// it does not say).
export function loadTone(load: string, cores: number, limit: number | null): 'warning' | 'error' | undefined {
  const n = Number(load)
  if (load === '' || !Number.isFinite(n)) return undefined
  return n >= (limit ?? cores * 4) ? 'error' : n >= cores ? 'warning' : undefined
}

export const oneDecimal = (load: string) => (Number.isFinite(Number(load)) && load !== '' ? Number(load).toFixed(1) : '?')

// A section is open when the person opened it; until then only a non-empty queue starts open.
export function isOpen(open: Record<string, boolean>, id: string, s: QueueSnapshot) {
  return open[id] ?? (id === 'queue' && s.queue.length > 0)
}

export function clock(ms: number) {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h12' }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(11, 19) + ' UTC'
  }
}
