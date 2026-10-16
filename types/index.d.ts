/** One rate-limit window, as the engine reports it. */
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** The live context, measured against the window auto-compaction works to. */
export type Context = {
  /** Input tokens the last main-loop response was answered over. */
  tokens: number
  /** The model's own context window. */
  modelWindow: number
  /** The window the band measures against: the auto-compact window when one is set. */
  window: number
  /** Where `window` came from: the engine's breakdown source, `env`, or `model`. */
  source: string
  /** Token count at which auto-compaction runs; null when it is off or unknown. */
  threshold: number | null
  /** Tokens the last prompt added; null before one finished. */
  delta: number | null
}

/** The last main-loop request's prompt, as the cache served it. */
export type CacheHit = { at: number; read: number; write: number; fresh: number }

export type RunningAgent = { id: string; type: string; description: string }

export type View = {
  context: Context | null
  /** The newest rate-limit reading, from this or another session. */
  limits: { at: number; list: RateLimit[] }
  cost: number | null
  lastPromptCost: number | null
  cache: CacheHit | null
  running: RunningAgent[]
  /** Ids of every agent seen this session. */
  seen: string[]
}

/** One job slot of the queue script, on this machine (`host` null) or a remote one. */
export type QueueSlot = { n: number; host: string | null; label: string | null; kind: string; mins: number; cwd: string }
/** A job waiting for a slot, in the order the queue serves them. */
export type QueueWaiter = { pos: number; label: string; kind: string; mins: number; cwd: string }
/** A remote machine the script sends jobs to: whether it is on, and its own memory and load line. */
export type QueueHost = { name: string; slots: number; state: string; check: string; detail: string }
/** One `status` reading of the queue script. */
export type QueueSnapshot = {
  local: QueueSlot[]
  remote: QueueSlot[]
  queue: QueueWaiter[]
  memoryFree: string
  pressure: string
  /** The one-minute load average, as printed. */
  load: string
  /** The load at which the script runs one job at a time, when it says. */
  loadLimit: number | null
  chats: string
  gate: string
  gateOn: boolean
  hosts: QueueHost[]
}
export type QueueReading = { at: number; snapshot: QueueSnapshot | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { view: View; queue: QueueReading; queueSections: Record<string, boolean> }
  }
}
