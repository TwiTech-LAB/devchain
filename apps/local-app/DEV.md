# Local App - Development Guide

## Development vs Production Serving

### Development Mode

In development, the Local App runs **two separate servers**:

1. **NestJS API Server** (port 3000)
   - Serves the REST API endpoints
   - WebSocket connections
   - Health checks at `/health`
   - API docs at `/api/docs`
   - Binds to `127.0.0.1:3000` (localhost only)

2. **Vite Dev Server** (port 5175)
   - Serves the React SPA with HMR (Hot Module Replacement)
   - Fast refresh for instant UI updates
   - Binds to `127.0.0.1:5175` (localhost only)
   - Proxies API requests to NestJS server

**To start development:**

```bash
# From the project root
pnpm dev

# Or from apps/local-app
pnpm dev
```

This runs both servers concurrently using `concurrently`. You'll see two colored outputs:
- **Blue**: NestJS API server logs
- **Magenta**: Vite dev server logs

**Access points:**
- UI: `http://127.0.0.1:5175/` (main app)
- API: `http://127.0.0.1:3000/api/*`
- Health: `http://127.0.0.1:3000/health`
- API Docs: `http://127.0.0.1:3000/api/docs`

### Production Mode

In production, the Local App runs **a single NestJS server** that serves both the API and the built SPA:

1. **Build Process:**
   ```bash
   pnpm build
   ```
   This:
   - Compiles NestJS TypeScript to JavaScript (`dist/`)
   - Builds the React SPA with Vite (`dist/client/`)

2. **Single Server:**
   - NestJS serves the API at `/api/*`
   - NestJS serves the built SPA at `/` (root) with SPA fallback
   - All requests for non-API routes serve `index.html` (SPA routing)
   - Binds to `127.0.0.1:3000` (localhost only)

**To start production:**

```bash
pnpm start
```

**Access point:**
- Everything: `http://127.0.0.1:3000/`

### Security: Localhost Binding

**Both development and production modes bind to `127.0.0.1` (localhost) only.**

This means:
- ✅ Accessible from the local machine
- ❌ NOT accessible from the network
- ❌ NOT accessible from other devices
- ✅ Secure by default (no remote exposure)

This is a core security principle of the Local App to prevent accidental network exposure.

### Architecture Diagram

```
Development Mode:
┌─────────────┐         ┌──────────────┐
│  Browser    │────────▶│  Vite Dev    │
│             │         │  :5175       │
│             │         │  (UI + HMR)  │
│             │         └──────┬───────┘
│             │                │ Proxy API
│             │         ┌──────▼───────┐
│             │────────▶│  NestJS      │
│             │         │  :3000       │
│             │         │  (API + WS)  │
└─────────────┘         └──────────────┘

Production Mode:
┌─────────────┐         ┌──────────────┐
│  Browser    │────────▶│  NestJS      │
│             │         │  :3000       │
│             │         │  (API + SPA) │
└─────────────┘         └──────────────┘
```

### Common Commands

```bash
# Development
pnpm dev              # Start both API and UI
pnpm dev:api          # Start only NestJS API
pnpm dev:ui           # Start only Vite dev server
pnpm dev:debug        # Start API with debugger

# Production
pnpm build            # Build both API and UI
pnpm start            # Start production server

# Testing
pnpm test             # Run unit tests
pnpm test:e2e         # Run E2E tests
pnpm test:watch       # Run tests in watch mode

# Code Quality
pnpm lint             # Check linting
pnpm lint:fix         # Fix linting issues
pnpm format           # Format code with Prettier

# Database
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Run migrations
pnpm db:push          # Push schema changes
pnpm db:studio        # Open Drizzle Studio
```

### Environment Variables

Create a `.env` file in `apps/local-app/` with:

```env
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
LOG_LEVEL=info
INSTANCE_MODE=local
```

All variables have sensible defaults and are validated with Zod on startup.

### Troubleshooting

**Problem**: Port 3000 or 5175 is already in use

**Solution**: Kill the process using the port or change the port in `.env`:
```bash
# Find and kill process
lsof -ti:3000 | xargs kill -9
lsof -ti:5175 | xargs kill -9
```

**Problem**: UI doesn't load or shows blank page

**Solution**:
1. Check that both servers are running (`pnpm dev`)
2. Check browser console for errors
3. Verify Vite dev server is at `http://127.0.0.1:5175/`

**Problem**: API requests fail with CORS errors

**Solution**: Ensure Vite is proxying requests correctly. In dev mode, API calls should go through Vite's proxy.

### Next Steps

See the main project README for:
- Overall architecture
- Data models
- Terminal integration
- MCP server design
- Roadmap
