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
- Deps: `pip install -r bot_py/requirements.txt`
- Config: `bot_py/config.py` (mirrors `bot/config.ts`; gitignored, never commit real keys).
- Rules: Keep this in sync with `./bot` when trading logic changes — the two implementations are meant to behave identically. `bot_py/backtest.py` ports the chronological simulator from `chart-analyzer/src/App.tsx` (margin/leverage tracking, multi-position handling, win-rate/MDD); keep it in sync with that too. State is persisted to `bot_py/state.json` (gitignored).

## 3. CI/CD Automation Mode
- If `CI=true`, do not generate interactive questions. Execute the prompt and terminate.

## 4. Language Policy
- **CRITICAL:** Even though these instructions are in English, you MUST generate all human-readable outputs (such as commit messages, PR descriptions, and code review comments) in **Korean (한국어)**.
