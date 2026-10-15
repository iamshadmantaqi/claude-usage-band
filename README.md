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

No network requests and nothing sent anywhere. The band reads the usage figures Claude Code already has (context, limits, cost, each request's cache token counts, the list of agents) and keeps the latest limits reading in the plugin's local store so other sessions can show it.

## Licence

MIT
