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

Individual server builds if needed:
```bash
npm run build:registry   # service-registry only
npm run build:perf       # perf-test-server only
npm run build:metrics    # spring-metrics only
npm run build:analyzer   # results-analyzer only
```

### 3. Set up your API key (agentic mode only)

Create a `.env` file in the project root:
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Verify everything is connected

```bash
python -m agent check
```

Expected output:
```
  ✓ service-registry: 4 tools
  ✓ perf-test: 3 tools
  ✓ spring-metrics: 5 tools
  ✓ results-analyzer: 4 tools

All 4 servers connected, 16 total tools available.
```

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

Parameterize tests with real user IDs, auth tokens, and request bodies — like JMeter's CSV Data Set Config.

```json
[
  {
    "entity_type": "account",
    "entity_id":   "1001",
    "token":       "Bearer eyJ...",
    "body_payment": { "amount": 100, "currency": "USD" }
  },
  {
    "entity_type": "account",
    "entity_id":   "1002",
    "token":       "Bearer eyJ...",
    "body_payment": { "amount": 200, "currency": "USD" }
  }
]
```

Each virtual user gets a different row (round-robin). Field naming conventions:

| Field | Purpose |
|-------|---------|
| `entity_id`, `user_id`, `order_id`, etc. | Replaces `{entity_id}` path placeholders |
| `token` | Injected as `Authorization` header |
| `body_<endpoint_name>` | Used as POST/PUT request body |
| `header_<name>` | Sent as a custom HTTP header |

---

## Running Tests

### Discover endpoints first (no API key needed)

```bash
python -m agent discover payment-service
python -m agent discover payment-service --env dev
```

---

### Mode 1 — Agentic (natural language, requires API key)

Describe what you want in plain English. The AI decides which tools to call, in what order, and adapts based on results.

```bash
# Basic test
python -m agent run "test payment-service with 3 users on local"

# Capacity planning
python -m agent run "find the breaking point of payment-service on dev"

# Regression check
python -m agent run "run payment-service and compare against baseline payment-v1.0"

# With detailed reasoning output
python -m agent run "test payment-service" --verbose

# CI/CD mode (exits 0=pass, 1=regression)
python -m agent run "regression check payment-service staging" --ci
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
python -m agent test --service payment-service

# With explicit parameters
python -m agent test --service payment-service --users 3 --duration 30 --env dev

# Save results as a named baseline
python -m agent test --service payment-service --save-as payment-v1.0

# Compare against a saved baseline
python -m agent test --service payment-service --baseline payment-v1.0

# Both save and compare
python -m agent test --service payment-service --baseline payment-v1.0 --save-as payment-v1.1
```

#### Using environment variables (CI/CD pipelines)

All parameters can be set as environment variables:

```bash
export PERF_SERVICE=payment-service
export PERF_ENV=staging
export PERF_USERS=3
export PERF_DURATION=30
export PERF_BASELINE=payment-v1.0

python -m agent test --ci     # exits 0=pass, 1=regression detected
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
python -m agent run "<natural language instruction>"
python -m agent run "<instruction>" --verbose          # show each tool call
python -m agent run "<instruction>" --ci               # CI mode
python -m agent run "<instruction>" --model claude-opus-4-6  # different model

# Deterministic mode
python -m agent test --service <name>
python -m agent test --service <name> --env <env> --users <n> --duration <s>
python -m agent test --service <name> --baseline <name>
python -m agent test --service <name> --save-as <name>
python -m agent test --service <name> --ci

# Utilities
python -m agent discover <service>                     # list testable endpoints
python -m agent discover <service> --env staging
python -m agent check                                  # verify MCP servers are running
python -m agent list-tools                             # show all available MCP tools
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
├── agent/                        # Python agent
│   ├── main.py                   # CLI entry point (run, test, discover, check)
│   ├── agent.py                  # ReAct loop — agentic mode
│   ├── mcp_client.py             # MCP server connection manager
│   └── prompts.py                # System prompt for Claude
├── mcp-servers/                  # TypeScript MCP servers
│   ├── service-registry/         # list_services, discover_endpoints, get_service_config
│   ├── perf-test-server/         # generate_k6_script, run_k6_test, list_test_scripts
│   ├── spring-metrics/           # check_health, snapshot_metrics, get_runtime_metrics
│   └── results-analyzer/         # analyze_results, compare_baseline, save_baseline, generate_report
├── config/
│   └── services.yaml             # service catalog — register services here
├── test-data/                    # per-VU test data (user IDs, tokens, request bodies)
├── test-scripts/                 # generated k6 scripts (auto-created)
├── results/                      # k6 results, snapshots, reports (auto-created)
├── baselines/                    # saved baselines for regression tracking (auto-created)
├── .env                          # ANTHROPIC_API_KEY (agentic mode only)
├── pyproject.toml                # Python project config & dependencies
└── package.json                  # Node.js workspace config
```
