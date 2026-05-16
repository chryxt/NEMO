# driftcore

Polymarket Microstructure Engine — real-time market analysis, paper trading, and supervised live execution.

## Quick Start

```bash
npm install
cp .env.example .env
# edit .env as needed
npm run dev
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start engine with ts-node-dev (auto-reload) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled output |
| `npm run typecheck` | Type-check without emitting |

## Modes

Set flags in `.env`:

| Mode | Env var | Notes |
|---|---|---|
| Live (default) | — | Connects to Polymarket WS feeds |
| File replay | `REPLAY_FILE=...` | Deterministic replay of recorded session |
| DB replay | `DB_REPLAY_FROM=...` | Replay from PostgreSQL journal |
| Simulation | `SIMULATION_MODE=true` | Paper execution against replay |
| Research | `RESEARCH_MODE=true` | Signal analysis + CSV export |
| Validation | `VALIDATION_MODE=true` | Walk-forward, Monte Carlo, sweep |
| Live paper | `LIVE_PAPER_ENABLED=true` | Paper trades on live data |
| Ops | `OPS_ENABLED=true` | Long-run edge persistence + reports |
| Shadow | `SHADOW_ENABLED=true` | Dry-run EIP-712 signing + approval queue |
| Execution | `EXECUTION_ENABLED=true` + `EXECUTION_ARMED=true` + `EXECUTION_DRY_RUN=false` | Supervised micro-live (triple-flag) |

## Safety

- Execution gateway defaults: `EXECUTION_ENABLED=false`, `EXECUTION_ARMED=false`, `EXECUTION_DRY_RUN=true`
- Triple-flag activation required for any real order submission
- Per-order operator approval via file-based queue and Unix-socket console
- Emergency halt: one-way, no auto-reset
- Private keys: `SecureSecret` wrapper — never logged, never in config object
