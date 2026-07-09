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

### Trading Bot (Node.js + TypeScript)
- Path: `./bot`
- Run (from repo root): `tsx bot/index.ts`
- Config: `bot/config.ts` (API keys, leverage, risk sizing, Telegram alert settings) — never commit real keys.
- Rules: No package.json/lint/test setup exists for this directory yet; keep changes consistent with existing file style. State is persisted to `bot/state.json` (gitignored).

## 3. CI/CD Automation Mode
- If `CI=true`, do not generate interactive questions. Execute the prompt and terminate.

## 4. Language Policy
- **CRITICAL:** Even though these instructions are in English, you MUST generate all human-readable outputs (such as commit messages, PR descriptions, and code review comments) in **Korean (한국어)**.
