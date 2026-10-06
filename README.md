# Jio

Jio decides where a group should meet, fairly, keeps the plan alive when the weather turns, and suggests what to do once everyone is together.

IS216 Web Application Development 2 group project.

## Prerequisites

- Node.js 24 (`nvm use` reads `.nvmrc`)
- pnpm 12. This repo is a pnpm workspace; never run npm here.

## Setup

```bash
pnpm install
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
```

Fill in both `.env` files. The comments in each `.env.example` say where every value comes from.

## Run

```bash
pnpm dev:backend    # http://localhost:3000/healthz
pnpm dev:frontend   # http://localhost:5173
```

The backend serves the planner at `POST /api/meeting-area`, `/api/converge`, `/api/roam` and `/api/search`. Requests and responses are in [backend/docs/planner-api.md](backend/docs/planner-api.md); how the engine and the venue data fit together is in [backend/docs/engine-integration.md](backend/docs/engine-integration.md).

## Test

```bash
pnpm test           # backend unit tests (vitest)
pnpm build          # frontend production build
```

End-to-end tests (Playwright) arrive with the test suite.

## Repository layout

- `frontend/` Vue 3 + Vite app
- `backend/` Express API: secrets and computation only
- `db/` schema, Row Level Security policies and seed scripts
