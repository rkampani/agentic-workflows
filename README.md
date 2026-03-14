# Agentic Performance Testing Platform

An AI-powered load testing platform that lets you describe what you want tested in plain English — or run a fully deterministic pipeline with explicit parameters. Both modes use the same underlying infrastructure: no manual k6 scripting required.

---

## How It Works

```
You (natural language or CLI flags)
         ↓
   Python Agent / Deterministic Pipeline
         ↓
   4 MCP Servers (run locally on your machine)
    ├── Service Registry   → discover endpoints from live Swagger/OpenAPI
    ├── Perf Test Server   → generate & run k6 load tests
    ├── App Metrics Server → capture server-side metrics (health, JVM, DB pool)
    └── Results Analyzer   → grade results, compare baselines, generate reports
         ↓
   k6 (load testing tool — runs locally)
         ↓
   results/   baselines/   test-scripts/
```

**Nothing leaves your machine** except the request instruction and aggregate stats (p95, error rate, throughput) sent to the AI model. Auth tokens, request/response payloads, and raw API data stay local at all times.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | 3.11+ | [python.org](https://python.org) |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| k6 | latest | `brew install k6` (macOS) / [k6.io/docs](https://k6.io/docs/get-started/installation/) |
| Anthropic API key | — | Required for agentic mode only |

---

## Installation & Build

### 1. Clone and install Python dependencies

```bash
git clone <repo-url>
cd agentic-workflows
pip install -e .
```

### 2. Build the MCP servers (TypeScript → JavaScript)

```bash
npm install
npm run build
```

### 3. Set up your API key (agentic mode only)

Create a `.env` file in the project root:
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Verify everything is connected

```bash
python3 -m agent check
```

Expected output:
```
  ✓ service-registry: 4 tools
  ✓ perf-test: 3 tools
  ✓ spring-metrics: 5 tools
  ✓ results-analyzer: 4 tools

All 4 servers connected, 16 total tools available.
```

### 5. Start the dashboard (optional)

```bash
npm run dashboard
```

Opens a web UI at **http://localhost:3000** — run tests and view results without touching the command line.

---

## Registering Your Services

Edit `config/services.yaml` to add your services. This is the central catalog the platform reads from.

```yaml
services:
  payment-service:
    description: "Payment processing API"
    team: "payments"
    framework: "spring"                        # spring | fastapi | flask | express | go
    swagger_path: "/v3/api-docs"               # path to OpenAPI spec
    environments:
      local:   "http://localhost:8080/payment-service/v4"
      dev:     "http://dev-host:8080/payment-service/v4"
      staging: "http://staging-host:8080/payment-service/v4"
    test_data_file: "test-data/payment-service/payment-service.json"
    auth:                                      # optional — k6 fetches a live token before the test
      url:      "http://localhost:8080/auth/token"
      username: "perf-test-user"
      password: "changeme"
      # token_field: "access_token"            # which response field holds the token (default: access_token)
    include_endpoints:                         # only these endpoints are tested
      - "GET /order-payment/{entity_type}/{entity_id}"
    exclude_endpoints:                         # these are always skipped
      - "GET /health"
      - "/metrics*"
      - "DELETE *"
    max_concurrent_users: 3                    # safety cap — cannot be exceeded
    max_duration_seconds: 30

defaults:
  max_concurrent_users: 500
  max_duration_seconds: 600
  allowed_environments:
    - local
    - dev
    - staging
```

If all your services share the same auth server you can set the URL and credentials once in `config/defaults.yaml` under `auth:` and omit them per service.

### Endpoint Filtering Rules

| Config | Behavior |
|--------|----------|
| `include_endpoints` | **Only** these endpoints are tested — everything else is skipped |
| `exclude_endpoints` | These endpoints are always skipped |
| Both defined | Include runs first, then exclude is applied on top |
| Neither defined | All endpoints from the Swagger spec are tested |

Pattern syntax:
```yaml
- "GET /api/orders"             # exact method + path
- "GET /api/orders*"            # wildcard suffix
- "*/admin/*"                   # wildcard anywhere
- "DELETE *"                    # all DELETE endpoints
- "/metrics*"                   # any method, path starts with /metrics
```

### Test Data File

Parameterize tests with real IDs and request bodies. Each virtual user gets a different row (round-robin).

**Flat style — preferred.** Just put the fields your API expects. The platform reads the OpenAPI schema and automatically picks the right fields for each endpoint's body:

```json
[
  { "entity_type": "account", "entity_id": "1001", "amount": 100, "currency": "USD" },
  { "entity_type": "account", "entity_id": "1002", "amount": 200, "currency": "USD" }
]
```

- Path placeholders like `{entity_id}` are always resolved from the row
- POST/PUT body is built from whichever fields in the row match the OpenAPI schema
- No `token` field needed when `auth:` is configured — the token is fetched automatically

**Explicit style — when one row covers multiple endpoints with different bodies:**

```json
[
  {
    "entity_type": "account",
    "entity_id":   "1001",
    "body_POST_/api/v1/payments": { "amount": 100, "currency": "USD" },
    "body_POST_/api/v1/refunds":  { "reason": "duplicate" }
  }
]
```

Use `body_<METHOD>_<path>` to target a specific endpoint. Fallback: `body_<endpoint-name>` (e.g. `body_payments`).

---

## Dashboard

Start the web UI with:

```bash
npm run dashboard
# → http://localhost:3000
```

**Run Test tab**

| Mode | What it does |
|------|-------------|
| 🎯 Deterministic | Pick a service, environment, VUs, and duration from a form. Same inputs → same run every time. |
| 🤖 Agent Mode | Describe what you want tested in plain English. The AI decides the strategy. |

Both modes stream live output to the browser as the test runs.

**Results tab**

Lists every past run. Click any entry to see:
- p95 / p99 latency, throughput (req/s), error rate
- Latency distribution bar chart
- Threshold pass/fail summary

No API key is needed to use Deterministic mode or view results.

---

## Running Tests (CLI)

### Discover endpoints first (no API key needed)

```bash
python3 -m agent discover payment-service
python3 -m agent discover payment-service --env dev
```

---

### Mode 1 — Agentic (natural language, requires API key)

Describe what you want in plain English. The AI decides which tools to call, in what order, and adapts based on results.

```bash
# Basic test
python3 -m agent run "test payment-service with 3 users on local"

# Capacity planning
python3 -m agent run "find the breaking point of payment-service on dev"

# Regression check
python3 -m agent run "run payment-service and compare against baseline payment-v1.0"

# With detailed reasoning output
python3 -m agent run "test payment-service" --verbose

# CI/CD mode (exits 0=pass, 1=regression)
python3 -m agent run "regression check payment-service staging" --ci
```

What the AI does for you:
- Discovers endpoints automatically
- Snapshots server metrics before and after
- Adapts if the service is unreachable or returns errors
- Correlates client latency with server-side causes (GC, DB pool, threads)
- Writes a plain-English report with specific recommendations

---

### Mode 2 — Deterministic (explicit parameters, no API key needed)

Fixed 6-step pipeline — same steps every run, no AI reasoning involved.

```bash
# Basic — uses safety caps from services.yaml as defaults
python3 -m agent test --service payment-service

# With explicit parameters
python3 -m agent test --service payment-service --users 3 --duration 30 --env dev

# Save results as a named baseline
python3 -m agent test --service payment-service --save-as payment-v1.0

# Compare against a saved baseline
python3 -m agent test --service payment-service --baseline payment-v1.0

# Both save and compare
python3 -m agent test --service payment-service --baseline payment-v1.0 --save-as payment-v1.1
```

#### Using environment variables (CI/CD pipelines)

All parameters can be set as environment variables:

```bash
export PERF_SERVICE=payment-service
export PERF_ENV=staging
export PERF_USERS=3
export PERF_DURATION=30
export PERF_BASELINE=payment-v1.0

python3 -m agent test --ci     # exits 0=pass, 1=regression detected
```

#### What the deterministic pipeline runs

```
[1/6] discover_endpoints     → reads services.yaml, fetches live Swagger spec, applies filters
[2/6] generate_k6_script     → writes test-scripts/<service>-deterministic.js
[3/6] snapshot_metrics       → captures health, JVM/memory, DB pool (skips if unavailable)
[4/6] run_k6_test            → fires k6 with ramp-up → steady → ramp-down pattern
[5/6] snapshot_metrics       → captures post-test server state
[6/6] analyze + report       → grades A–F, compares baseline, saves Markdown to results/reports/
```

#### CI output format

```
VERDICT: PASS
GRADE: A
p95: 142ms | p99: 380ms | errors: 0%
```

```
VERDICT: FAIL
REGRESSIONS: p95_ms increased 52%, Throughput decreased 18%
GRADE: C
p95: 1840ms | p99: 4200ms | errors: 0.5%
```

---

## Choosing a Mode

| | Agentic `run` | Deterministic `test` |
|--|:--:|:--:|
| Requires Anthropic API key | Yes | No |
| Natural language input | Yes | No |
| Adapts to unexpected results | Yes | No |
| Fixed, predictable steps | No | Yes |
| CI/CD pipeline friendly | Yes | Yes |
| Plain-English report narrative | Yes | No (structured table) |
| Best for | Exploratory testing, investigations | Scheduled runs, regression gating |

---

## Output & Results

| Location | Contents |
|----------|---------|
| `test-scripts/` | Generated k6 JavaScript files |
| `results/` | k6 JSON result files |
| `results/snapshots/` | Before/after server metrics snapshots |
| `results/reports/` | Markdown performance reports |
| `baselines/` | Saved baselines for regression comparison |

---

## All Commands

```bash
# Agentic mode
python3 -m agent run "<natural language instruction>"
python3 -m agent run "<instruction>" --verbose          # show each tool call
python3 -m agent run "<instruction>" --ci               # CI mode
python3 -m agent run "<instruction>" --model claude-opus-4-6  # different model

# Deterministic mode
python3 -m agent test --service <name>
python3 -m agent test --service <name> --env <env> --users <n> --duration <s>
python3 -m agent test --service <name> --baseline <name>
python3 -m agent test --service <name> --save-as <name>
python3 -m agent test --service <name> --ci

# Utilities
python3 -m agent discover <service>                     # list testable endpoints
python3 -m agent discover <service> --env staging
python3 -m agent check                                  # verify MCP servers are running
python3 -m agent list-tools                             # show all available MCP tools
```

---

## Security & Data Privacy

The AI model (Claude) only ever sees:
- Your plain English instruction (agentic mode)
- Aggregate statistics: p95 latency, error rate, throughput
- Endpoint paths (structure only — e.g. `/api/orders/{order_id}`)
- Performance grade and notes

The AI model **never** sees:
- Auth tokens or Bearer tokens (injected locally by k6)
- Request or response bodies (k6 runs locally)
- Real user IDs or PII from test data files
- Raw API responses from your services
- Internal service URLs or hostnames
- Database contents or business data

All load test traffic goes **directly from your machine to your service** — it does not pass through any external system.

---

## Project Structure

```
agentic-workflows/
├── backend/
│   ├── agent/                        # Python agent (CLI)
│   │   ├── prompts/                  # Claude system prompts (edit here to tune AI behaviour)
│   │   │   ├── system_prompt.txt
│   │   │   └── ci_mode_prompt.txt
│   │   └── ...
│   └── mcp-servers/                  # TypeScript backend servers
│       ├── service-registry/         # discovers endpoints from live OpenAPI specs
│       ├── perf-test-server/         # generates and runs k6 load tests
│       ├── spring-metrics/           # captures server-side metrics
│       └── results-analyzer/         # grades results, compares baselines, generates reports
├── frontend/
│   └── dashboard/                    # web UI (npm run dashboard → localhost:3000)
│       └── public/                   # HTML / CSS / JS — no build step for the UI
├── config/                           # shared configuration (read by both backend and frontend)
│   ├── services.yaml                 # register your services here
│   ├── defaults.yaml                 # global defaults (users cap, thresholds, auth fallbacks)
│   └── mcp-servers.yaml              # MCP server process definitions
├── test-data/                        # per-VU test data rows (IDs, request bodies)
├── test-scripts/                     # generated k6 scripts (auto-created)
├── results/                          # k6 results, snapshots, reports (auto-created)
├── baselines/                        # saved baselines for regression tracking (auto-created)
├── .env                              # ANTHROPIC_API_KEY (agent mode only)
├── pyproject.toml                    # Python dependencies
└── package.json                      # Node.js workspace (npm workspaces)
```
