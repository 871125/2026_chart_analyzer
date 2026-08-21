# Project AI Constitution (CLAUDE.md)

## 1. Token Optimization Principles (CRITICAL)
- Do not read entire files over 500 lines without explicit user permission.
- Always check the file tree or use `ripgrep(rg)` to find the destination before opening files.
- Exclude files unrelated to the specific task from the context.

## 2. Tech Stack Guidelines
This repo has two parts: a React dashboard (`chart-analyzer`) and a standalone trading bot (`bot`). Execute commands in the respective directories.

### Frontend (React + Vite + TypeScript)
- Path: `./chart-analyzer`
- Dev server: `npm run dev`
- Build (includes typecheck): `npm run build`
- Lint: `npm run lint`
- Rules: Maintain component separation, optimize state hooks, strict TypeScript typing. No test runner is configured yet.

### Trading Bot (Node.js + TypeScript) — original
- Path: `./bot`
- Run (from repo root): `tsx bot/index.ts`
- Config: `bot/config.ts` (API keys, leverage, risk sizing, Telegram alert settings) — never commit real keys.
- Rules: No package.json/lint/test setup exists for this directory yet; keep changes consistent with existing file style. State is persisted to `bot/state.json` (gitignored).

### Trading Bot (Python) — port of `./bot`
- Path: `./bot_py`
- Run live bot (from repo root): `python -m bot_py.main`
- Run backtest (from repo root): `python -m bot_py.backtest --start YYYY-MM-DD [--end YYYY-MM-DD --symbol ... --interval ... --capital ... --risk ... --leverage ... --max-positions ... --rr ...]`
- Backtest cost/filter flags: `--entry-mode {taker,maker}`, `--fee-rate`, `--maker-fee-rate`, `--slippage-pct`, `--min-stop-pct`, `--max-pending-candles`, `--reserve-slots`, `--max-same-direction`, `--intrabar {loss,skip}`
- Deps: `pip install -r bot_py/requirements.txt`
- Config: `bot_py/config.py` (mirrors `bot/config.ts`; gitignored, never commit real keys).
- Entry mode: both the live bot (`config.TRADING_OPTIONS.entry_mode`, default `maker`) and the backtest (`--entry-mode`) support post-only limit entry at EP + limit TP exit, with SL always market. Keep the two in sync when changing fill logic.
- `--reserve-slots on` (default, multi-symbol only) models the live maker mode: a pending box with a resting limit order at EP occupies a `max_positions` slot, so boxes can pile up unarmed. Turn it off only to compare against the old assumption.
- Entry filters are mirrored on both sides and must stay in sync: minimum stop width (`min_stop_pct` / `--min-stop-pct`, default 0.7%) and pending-box expiry (`max_pending_candles` / `--max-pending-candles`, default 30 candles).
- `--intrabar` note: when a single candle touches both EP and SL, `loss` (default) books it as an entry-then-stop, `skip` restores the old behavior that recorded no trade at all. The old behavior overstated win rate by ~9%p.
- Rules: `bot_py` has diverged from `./bot` on purpose — it now trades multiple symbols (`config.TRADING_OPTIONS.binance_symbols`) against one shared capital/margin pool instead of a single symbol (`./bot` still trades one symbol only). Don't assume the two stay in sync; `./bot` is legacy/reference only per user instruction. `bot_py/backtest.py` has both `run_backtest()` (single symbol) and `run_multi_symbol_backtest()` (shared pool, used when `--symbol` gets a comma-separated list). State is persisted to `bot_py/state.json` (gitignored).

## 3. CI/CD Automation Mode
- If `CI=true`, do not generate interactive questions. Execute the prompt and terminate.

## 4. Language Policy
- **CRITICAL:** Even though these instructions are in English, you MUST generate all human-readable outputs (such as commit messages, PR descriptions, and code review comments) in **Korean (한국어)**.
