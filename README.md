# Usage Band

A Claude Code mod that puts one tidy bar above the prompt:

```
◔ 281k / 400k +9.8k │ 5h ━━──── 28% 2h 00m │ 7d ─────── 7% 4d 4h │ cache 59m │ $191 │ 5 running / 38
```

In the desktop app each segment is drawn with a small ring, bar or icon and opens a hover card with the detail.

| Segment | What it shows |
| --- | --- |
| Context | Tokens in the context against the **auto-compact window** (for example `autoCompactWindow: 400000` in settings), not the model's full window. The ring fills as you approach it. The hover card says where the window came from, the model's own window and the token count where auto-compaction runs. |
| 5h / 7d | Share of your plan's limits used. The bar's tick marks how much of the window has passed, so a fill past the tick means you are ahead of pace. Then the time to reset. A 7-day projection (`out Fri`) appears when the week's pace would use it up before the reset. |
| Cache | Time left before the prompt cache lapses (1 hour on a plan, 5 minutes on an API key), `cold` once it has. The hover card shows the share of the last message read from the cache. |
| Cost | Session cost at API prices, as `/cost` totals it. The hover card adds the last prompt's cost. |
| Agents | Subagents running now, out of all the session has run, with what each is doing in the hover card. |

Colour only carries state: blue while things are fine, amber when ahead of pace or running short, red at the edge.

## Job queue row (optional)

On a machine that runs heavy jobs (builds, test runs, dev servers) through a queue script, the band can show that queue on a row above it:

```
◇ Heavy  Mac 0/2 · box-a 1/3 · box-b 0/8 · Queue 0 · Mem 79% free  Load 2.7
```

Click the row (or run the slash command named after the script, `/heavy` for `heavy.sh`) to open a side pane with each slot, the waiting jobs in order and each remote machine, in sections that open on click. Amber means jobs are waiting or the load has passed the core count; red means memory pressure is critical, the load has reached the script's own limit, or a remote machine is off.

Set the option to the script's path in `/config` or in `settings.json`:

```json
"pluginConfigs": { "usage-band@usage-band": { "options": { "queueScript": "~/tools/heavy.sh" } } }
```

Left empty, nothing runs and no row shows. The script is run as `<path> status` every few seconds; when several sessions are open, one of them runs it and the rest read its result from the plugin's local store. The output it reads, one line each:

```
slot 1: free
slot 2: web/fix-x, run pid 123, 3 min, in /path/to/worktree
remote slot 1 (box-a): api/tests, run pid 456, 0 min, in /path/to/worktree
queue 1: api/orders, run pid 789, waiting 4 min, in /path/to/worktree
memory free: 79%
memory pressure: normal
load:  2.67 2.35 2.13
chats working (last 2 min): 2
gate: off (load limit 40, ...)
remote (box-a, 3 slots): on, last check: ok (1 min ago)
  box-a: memory 3 of 9 GB used, ..., load 1.61 0.44 0.15, ...
```

## How the context window is read

The engine's `/context` breakdown (`$.session.usage({ breakdown: "summary" })`) reports the window the session compacts against as `rawMaxTokens`, along with its source and the auto-compact threshold. The band reads it at start, after a compaction and at most every five minutes. Without a breakdown it falls back to `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the model's window.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-band --marketplace iamshadmantaqi/claude-usage-band
```

Answer `y` to add the marketplace, then pick the user scope. A mod installed at the user scope also draws in the desktop app's Code tab.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## Privacy

No network requests and nothing sent anywhere. With the job queue option set it also runs that script locally. The band reads the usage figures Claude Code already has (context, limits, cost, each request's cache token counts, the list of agents) and keeps the latest limits reading in the plugin's local store so other sessions can show it.

## Licence

MIT
