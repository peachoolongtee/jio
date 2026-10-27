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

The backend serves the planner at `POST /api/meeting-area`, `/api/converge`, `/api/roam` and `/api/search`. Requests and responses are in [backend/docs/planner-api.md](backend/docs/planner-api.md); how the engine and the venue data fit together is in [backend/docs/engine-integration.md](backend/docs/engine-integration.md). Every change on the engine branch, and how to switch the frontend over to the API, is in [backend/docs/changes-and-frontend-guide.md](backend/docs/changes-and-frontend-guide.md). The frontend now uses that API; how to merge frontend work on top of it without conflicts is in [frontend/docs/backend-integration.md](frontend/docs/backend-integration.md).

In development the frontend calls `/api` on its own address and the Vite dev server forwards those calls to the backend on port 3000, so leave `VITE_API_BASE_URL` blank in `frontend/.env`. This also works in a GitHub codespace, where the page opens at a forwarded address. Only a deployed frontend calls the backend directly, from the one origin it allows (`FRONTEND_ORIGIN`).

## Test

```bash
pnpm test                          # backend unit tests (vitest)
pnpm --filter jio-frontend test    # frontend unit tests, plus a whole session run against the real backend
pnpm build                         # frontend production build
```

End-to-end tests (Playwright) start their own stub backend and frontend, and never touch a real service: see `frontend/tests/e2e/README.md` (`pnpm test:e2e`).

## Repository layout

- `frontend/` Vue 3 + Vite app
- `backend/` Express API: secrets and computation only
- `db/` schema, Row Level Security policies and seed scripts
