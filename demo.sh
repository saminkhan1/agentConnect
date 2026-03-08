#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  AgentConnect v0.3.0 — End-to-End Demo
#
#  Story: "You give each AI agent an identity. We provision real email inboxes,
#  enforce your org's send policy, and every action becomes a canonical,
#  queryable event log. One API. Multi-tenant. Production-hardened auth."
#
#  Covers:
#    ✦ Happy path  (org → agents → inboxes → send → event log)
#    ✦ Policy enforcement (blocked_domains, max_recipients, allowed_domains)
#    ✦ Auth & permission errors (no auth, bad key, wrong scope)
#    ✦ Validation errors (Zod ingress rejection)
#    ✦ Tenant isolation (cross-org data walls)
#    ✦ Idempotency (exactly-once event delivery)
#    ✦ Cursor-paged event log (filter by type, paginate)
#    ✦ Agent archival + resource deprovisioning
#
#  Reusable runs:
#    State (org, agents, inboxes) is saved to .demo-state after the first run.
#    Subsequent runs load that state and skip provisioning — staying within the
#    3-inbox limit of the AgentMail free plan.
#    Delete .demo-state to force a fully fresh run.
#
#  Usage:  ./demo.sh [BASE_URL]
#  Prereq: curl, jq
#
#  Start server first:
#    AGENTMAIL_API_KEY=<key> AGENTMAIL_WEBHOOK_SECRET=<secret> npm run dev
# ══════════════════════════════════════════════════════════════════════════════

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
STATE_FILE="${STATE_FILE:-.demo-state}"

# ── ANSI ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m';  GREEN='\033[0;32m';  YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m';   BOLD='\033[1m'
DIM='\033[2m';     NC='\033[0m'

PASS_COUNT=0; FAIL_COUNT=0

pass()  { echo -e "  ${GREEN}✓${NC}  $*";  PASS_COUNT=$((PASS_COUNT + 1)); }
fail()  { echo -e "  ${RED}✗${NC}  $*";   FAIL_COUNT=$((FAIL_COUNT + 1)); }
info()  { echo -e "  ${DIM}    $*${NC}"; }
step()  { echo -e "\n  ${CYAN}▶  $*${NC}"; }
abort() { echo -e "\n  ${RED}FATAL: $*${NC}\n"; exit 1; }

section() {
  echo ""
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
  printf "${BOLD}${BLUE}  [%02d] %s${NC}\n" "$1" "$2"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
}

json_peek() {
  # Print first 10 lines of JSON, indented and dimmed
  echo "$1" | jq '.' 2>/dev/null | head -10 | while IFS= read -r line; do
    echo -e "  ${DIM}    ${line}${NC}"
  done
}

# ── HTTP client ───────────────────────────────────────────────────────────────
_TMP=$(mktemp)
trap 'rm -f "$_TMP"' EXIT

HTTP_STATUS=""
HTTP_BODY=""

call() {
  # call <METHOD> <PATH> [AUTH_TOKEN] [JSON_BODY]
  local method="$1" path="$2" auth="${3:-}" body="${4:-}"
  local -a args=(-s -o "$_TMP" -w "%{http_code}"
                 -X "$method" "${BASE_URL}${path}")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Bearer $auth")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  HTTP_STATUS=$(curl "${args[@]}" 2>/dev/null || echo "000")
  HTTP_BODY=$(cat "$_TMP" 2>/dev/null || echo "{}")
}

assert_http() {
  # assert_http <label> <expected_status>
  if [[ "$HTTP_STATUS" == "$2" ]]; then
    pass "HTTP ${HTTP_STATUS} — $1"
  else
    fail "HTTP ${HTTP_STATUS} (expected $2) — $1"
    local msg; msg=$(echo "$HTTP_BODY" | jq -r '.message // empty' 2>/dev/null)
    [[ -n "$msg" ]] && info "→ $msg"
  fi
}

assert_contains() {
  # assert_contains <label> <haystack> <needle>
  if echo "$2" | grep -qi "$3" 2>/dev/null; then
    pass "$1"
  else
    fail "$1 (expected to contain: '$3', got: '$2')"
  fi
}

jq_r() { echo "$1" | jq -r "$2" 2>/dev/null; }

require_var() {
  # require_var <label> <value>
  if [[ -z "$2" || "$2" == "null" ]]; then
    abort "Could not extract $1 — check server output above"
  fi
}

# ── State persistence ─────────────────────────────────────────────────────────
save_state() {
  cat > "$STATE_FILE" << STATEFILE
SAVED_BASE_URL="${BASE_URL}"
ORG_ID="${ORG_ID:-}"
ROOT_KEY="${ROOT_KEY:-}"
SERVICE_KEY="${SERVICE_KEY:-}"
AGENT_ALICE="${AGENT_ALICE:-}"
AGENT_BOB="${AGENT_BOB:-}"
AGENT_VAULT="${AGENT_VAULT:-}"
ALICE_RESOURCE_ID="${ALICE_RESOURCE_ID:-}"
ALICE_EMAIL="${ALICE_EMAIL:-}"
BOB_RESOURCE_ID="${BOB_RESOURCE_ID:-}"
BOB_EMAIL="${BOB_EMAIL:-}"
VAULT_RESOURCE_ID="${VAULT_RESOURCE_ID:-}"
VAULT_EMAIL="${VAULT_EMAIL:-}"
ALICE_INBOX_NEEDS_REPROVISION=${ALICE_INBOX_NEEDS_REPROVISION:-false}
STATEFILE
}

# ══════════════════════════════════════════════════════════════════════════════
#  BANNER
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${BLUE}"
cat << 'BANNER'
  ╔═══════════════════════════════════════════════════════════════╗
  ║         AgentConnect v0.3.0  ·  E2E Demo                     ║
  ║                                                               ║
  ║  "One API. Real agent identities. Immutable event log."      ║
  ╚═══════════════════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"
echo -e "  Target: ${CYAN}${BASE_URL}${NC}"
echo -e "  Time:   $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
for dep in curl jq; do
  command -v "$dep" &>/dev/null \
    && echo -e "  ${GREEN}✓${NC}  $dep" \
    || abort "$dep not found — brew install $dep"
done

step "Health check"
call GET /health
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo -e "\n  ${RED}Server not responding at ${BASE_URL}${NC}"
  echo ""
  echo -e "  Start it with:"
  echo -e "  ${CYAN}    AGENTMAIL_API_KEY=<key> AGENTMAIL_WEBHOOK_SECRET=<secret> npm run dev${NC}"
  exit 1
fi
pass "Server is up"

# ── State management ──────────────────────────────────────────────────────────
ALICE_INBOX_NEEDS_REPROVISION=false
STATE_LOADED=false
ORG_ID="${ORG_ID:-}"

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  if [[ "${SAVED_BASE_URL:-}" == "$BASE_URL" && -n "${ORG_ID:-}" ]]; then
    echo -e "\n  ${CYAN}↺  Found saved state ($STATE_FILE) — verifying against server…${NC}"
    call GET "/agents/${AGENT_ALICE:-missing}" "${ROOT_KEY:-}"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      pass "Saved state valid — provisioning steps will be skipped"
      STATE_LOADED=true
    else
      echo -e "  ${YELLOW}!  Saved state is stale (HTTP ${HTTP_STATUS}) — starting fresh${NC}"
      rm -f "$STATE_FILE"
      ORG_ID=""; ROOT_KEY=""; SERVICE_KEY=""
      AGENT_ALICE=""; AGENT_BOB=""; AGENT_VAULT=""
      ALICE_RESOURCE_ID=""; ALICE_EMAIL=""; BOB_RESOURCE_ID=""
      BOB_EMAIL=""; VAULT_RESOURCE_ID=""; VAULT_EMAIL=""
      ALICE_INBOX_NEEDS_REPROVISION=false
    fi
  else
    echo -e "\n  ${YELLOW}!  State file is for a different server (${SAVED_BASE_URL:-?}) — starting fresh${NC}"
    rm -f "$STATE_FILE"
    ORG_ID=""; ROOT_KEY=""; SERVICE_KEY=""
    AGENT_ALICE=""; AGENT_BOB=""; AGENT_VAULT=""
    ALICE_RESOURCE_ID=""; ALICE_EMAIL=""; BOB_RESOURCE_ID=""
    BOB_EMAIL=""; VAULT_RESOURCE_ID=""; VAULT_EMAIL=""
    ALICE_INBOX_NEEDS_REPROVISION=false
  fi
fi

# Re-provision Alice's inbox if it was deprovisioned in a previous run
if [[ "$STATE_LOADED" == "true" && "$ALICE_INBOX_NEEDS_REPROVISION" == "true" ]]; then
  step "Re-provisioning Alice's inbox (deprovisioned in previous run)"
  call POST "/agents/${AGENT_ALICE}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{"blocked_domains":["competitor.com"],"max_recipients":3}}'
  assert_http "Re-provision Alice inbox" 201
  ALICE_RESOURCE_ID=$(jq_r "$HTTP_BODY" '.resource.id')
  ALICE_EMAIL=$(jq_r "$HTTP_BODY" '.resource.providerRef')
  require_var "alice_resource_id" "$ALICE_RESOURCE_ID"
  require_var "alice_email"       "$ALICE_EMAIL"
  ALICE_INBOX_NEEDS_REPROVISION=false
  save_state
  info "Alice's new inbox: $ALICE_EMAIL"
fi

# Restore vault-relay if it was archived in a previous run and not cleaned up
if [[ "$STATE_LOADED" == "true" && -n "${AGENT_VAULT:-}" ]]; then
  call GET "/agents/${AGENT_VAULT}" "$ROOT_KEY"
  if [[ "$(jq_r "$HTTP_BODY" '.agent.isArchived')" == "true" ]]; then
    step "Restoring vault-relay (was archived in a previous run)"
    call PATCH "/agents/${AGENT_VAULT}" "$ROOT_KEY" '{"isArchived":false}'
    [[ "$HTTP_STATUS" == "200" ]] \
      && pass "vault-relay restored" \
      || fail "Could not un-archive vault-relay"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
section 1 "Org Bootstrap  ·  tenant creation + API keys"
# ══════════════════════════════════════════════════════════════════════════════

if [[ -z "$ORG_ID" ]]; then
  step "POST /orgs — register 'Demo Corp'"
  call POST /orgs "" '{"name":"Demo Corp"}'
  assert_http "Create org" 201
  json_peek "$HTTP_BODY"

  ORG_ID=$(jq_r "$HTTP_BODY" '.org.id')
  ROOT_KEY=$(jq_r "$HTTP_BODY" '.apiKey.key')
  require_var "org_id"   "$ORG_ID"
  require_var "root_key" "$ROOT_KEY"
  info "org_id:   $ORG_ID"
  info "root_key: ${ROOT_KEY:0:24}…  (returned once — store it now)"

  step "POST /orgs/:id/api-keys — mint scoped service key"
  call POST "/orgs/${ORG_ID}/api-keys" "$ROOT_KEY" '{"keyType":"service"}'
  assert_http "Mint service key" 201
  SERVICE_KEY=$(jq_r "$HTTP_BODY" '.apiKey.key')
  require_var "service_key" "$SERVICE_KEY"
  info "service key scopes: agents:read · agents:write (no admin ops)"

  save_state
else
  step "Loaded from saved state — skipping org creation"
  info "org_id:   $ORG_ID"
  info "root_key: ${ROOT_KEY:0:24}…"
  info "service_key: loaded"
fi

# ══════════════════════════════════════════════════════════════════════════════
section 2 "Agent Provisioning  ·  3 agents, ~2 seconds"
# ══════════════════════════════════════════════════════════════════════════════

if [[ -z "$AGENT_ALICE" ]]; then
  step "Create alice-support-bot"
  call POST /agents "$ROOT_KEY" '{"name":"alice-support-bot"}'
  assert_http "Create alice" 201
  AGENT_ALICE=$(jq_r "$HTTP_BODY" '.agent.id')
  require_var "agent_alice" "$AGENT_ALICE"
  info "$AGENT_ALICE"

  step "Create bob-outreach-bot"
  call POST /agents "$ROOT_KEY" '{"name":"bob-outreach-bot"}'
  assert_http "Create bob" 201
  AGENT_BOB=$(jq_r "$HTTP_BODY" '.agent.id')
  require_var "agent_bob" "$AGENT_BOB"
  info "$AGENT_BOB"

  step "Create vault-relay (internal)"
  call POST /agents "$ROOT_KEY" '{"name":"vault-relay"}'
  assert_http "Create vault" 201
  AGENT_VAULT=$(jq_r "$HTTP_BODY" '.agent.id')
  require_var "agent_vault" "$AGENT_VAULT"
  info "$AGENT_VAULT"

  save_state
else
  step "Loaded from saved state — skipping agent creation"
  info "alice:  $AGENT_ALICE"
  info "bob:    $AGENT_BOB"
  info "vault:  $AGENT_VAULT"
fi

step "GET /agents — all 3 visible immediately"
call GET /agents "$ROOT_KEY"
assert_http "List agents" 200
AGENT_COUNT=$(jq_r "$HTTP_BODY" '.agents | length')
if [[ "$AGENT_COUNT" -ge 3 ]]; then
  pass "List shows $AGENT_COUNT agents"
else
  fail "Expected ≥3 agents, got $AGENT_COUNT"
fi

step "PATCH /agents/:id — rename alice (non-destructive update)"
call PATCH "/agents/${AGENT_ALICE}" "$ROOT_KEY" '{"name":"alice-support-v2"}'
assert_http "Rename alice" 200
ALICE_NAME=$(jq_r "$HTTP_BODY" '.agent.name')
[[ "$ALICE_NAME" == "alice-support-v2" ]] \
  && pass "Name updated → alice-support-v2" \
  || fail "Expected alice-support-v2, got $ALICE_NAME"

# ══════════════════════════════════════════════════════════════════════════════
section 3 "Email Inbox Provisioning  ·  per-agent send policies"
# ══════════════════════════════════════════════════════════════════════════════

if [[ -z "$ALICE_RESOURCE_ID" ]]; then
  step "Provision Alice's inbox  (blocked_domains=[competitor.com], max_recipients=3)"
  call POST "/agents/${AGENT_ALICE}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{"blocked_domains":["competitor.com"],"max_recipients":3}}'
  assert_http "Provision Alice inbox" 201
  json_peek "$HTTP_BODY"

  ALICE_RESOURCE_ID=$(jq_r "$HTTP_BODY" '.resource.id')
  ALICE_EMAIL=$(jq_r "$HTTP_BODY" '.resource.providerRef')
  require_var "alice_resource_id" "$ALICE_RESOURCE_ID"
  require_var "alice_email"       "$ALICE_EMAIL"
  ALICE_STATE=$(jq_r "$HTTP_BODY" '.resource.state')
  [[ "$ALICE_STATE" == "active" ]] && pass "state: active" || fail "Expected active, got $ALICE_STATE"
  info "Alice's inbox: $ALICE_EMAIL"
else
  step "Alice's inbox — loaded from saved state"
  info "resource_id: $ALICE_RESOURCE_ID"
  info "email:       $ALICE_EMAIL"
fi

if [[ -z "$BOB_RESOURCE_ID" ]]; then
  step "Provision Bob's inbox  (allowed_domains=[agentmail.to])"
  call POST "/agents/${AGENT_BOB}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{"allowed_domains":["agentmail.to"]}}'
  assert_http "Provision Bob inbox" 201

  BOB_RESOURCE_ID=$(jq_r "$HTTP_BODY" '.resource.id')
  BOB_EMAIL=$(jq_r "$HTTP_BODY" '.resource.providerRef')
  require_var "bob_resource_id" "$BOB_RESOURCE_ID"
  require_var "bob_email"       "$BOB_EMAIL"
  info "Bob's inbox: $BOB_EMAIL"
else
  step "Bob's inbox — loaded from saved state"
  info "resource_id: $BOB_RESOURCE_ID"
  info "email:       $BOB_EMAIL"
fi

if [[ -z "$VAULT_RESOURCE_ID" ]]; then
  step "Provision Vault's inbox  (no policy — unrestricted relay)"
  call POST "/agents/${AGENT_VAULT}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{}}'
  assert_http "Provision Vault inbox" 201

  VAULT_RESOURCE_ID=$(jq_r "$HTTP_BODY" '.resource.id')
  VAULT_EMAIL=$(jq_r "$HTTP_BODY" '.resource.providerRef')
  require_var "vault_resource_id" "$VAULT_RESOURCE_ID"
  require_var "vault_email"       "$VAULT_EMAIL"
  info "Vault's inbox: $VAULT_EMAIL"
else
  step "Vault's inbox — loaded from saved state"
  info "resource_id: $VAULT_RESOURCE_ID"
  info "email:       $VAULT_EMAIL"
fi

save_state

step "GET /agents/:id/resources — verify Alice has 1 active inbox"
call GET "/agents/${AGENT_ALICE}/resources" "$ROOT_KEY"
assert_http "List resources" 200
R_COUNT=$(jq_r "$HTTP_BODY" '.resources | length')
[[ "$R_COUNT" -eq 1 ]] \
  && pass "1 resource provisioned (state: active)" \
  || fail "Expected 1 resource, got $R_COUNT"

# ══════════════════════════════════════════════════════════════════════════════
section 4 "Happy Path  ·  send emails between agents"
# ══════════════════════════════════════════════════════════════════════════════
# All sends use real @agentmail.to addresses provisioned above.

step "Alice → Vault  (recipient is @agentmail.to — not in blocked_domains)"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$VAULT_EMAIL" \
    '{"to":[$to],"subject":"Hello from Alice","text":"Hi Vault, this is a live send."}')"
assert_http "Alice sends to Vault" 200

ALICE_SENT_EVENT=$(jq_r "$HTTP_BODY" '.event.id')
ALICE_SENT_TYPE=$(jq_r "$HTTP_BODY" '.event.eventType')
[[ "$ALICE_SENT_TYPE" == "email.sent" ]] \
  && pass "event.eventType = email.sent" \
  || fail "Expected email.sent, got $ALICE_SENT_TYPE"
info "Event ID: $ALICE_SENT_EVENT"
info "From:     $(jq_r "$HTTP_BODY" '.event.data.from')"
info "To:       $VAULT_EMAIL"

step "Vault → Alice  (no policy on Vault — always passes)"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" \
    '{"to":[$to],"subject":"Re: Hello","text":"Got it, Alice!"}')"
assert_http "Vault sends to Alice" 200
[[ "$(jq_r "$HTTP_BODY" '.event.eventType')" == "email.sent" ]] \
  && pass "event.eventType = email.sent" \
  || fail "Expected email.sent"

step "Bob → Alice  (@agentmail.to is in Bob's allowed_domains)"
call POST "/agents/${AGENT_BOB}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" \
    '{"to":[$to],"subject":"Outreach ping","text":"Hey Alice, Bob here."}')"
assert_http "Bob sends to Alice (allowed domain)" 200
[[ "$(jq_r "$HTTP_BODY" '.event.eventType')" == "email.sent" ]] \
  && pass "event.eventType = email.sent" \
  || fail "Expected email.sent"

# ══════════════════════════════════════════════════════════════════════════════
section 5 "Policy Enforcement  ·  guardrails that actually fire"
# ══════════════════════════════════════════════════════════════════════════════
# Policy is checked before any network call — no emails escape on violations.

step "Alice → competitor.com  (in blocked_domains) → 403"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ROOT_KEY" \
  '{"to":["spy@competitor.com"],"subject":"Leaked data","text":"..."}'
assert_http "Blocked domain → 403" 403
POLICY_MSG=$(jq_r "$HTTP_BODY" '.message')
assert_contains "Error mentions 'blocked'" "$POLICY_MSG" "blocked"
info "Reason: $POLICY_MSG"

step "Alice → 4 recipients  (max_recipients=3 exceeded) → 403"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ROOT_KEY" \
  '{"to":["a@ok.com","b@ok.com","c@ok.com","d@ok.com"],"subject":"Mass blast","text":"..."}'
assert_http "Recipient limit exceeded → 403" 403
POLICY_MSG=$(jq_r "$HTTP_BODY" '.message')
assert_contains "Error mentions 'max_recipients'" "$POLICY_MSG" "max_recipients"
info "Reason: $POLICY_MSG"

step "Alice → exactly 3 recipients  (at the limit) → 200"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg a "$ALICE_EMAIL" --arg b "$BOB_EMAIL" --arg v "$VAULT_EMAIL" \
    '{"to":[$a,$b,$v],"subject":"Team update","text":"All hands meeting!"}')"
assert_http "Exactly at recipient limit → 200" 200
info "Boundary condition passes: count(3) ≤ max_recipients(3)"

step "Bob → gmail.com  (not in allowed_domains=[agentmail.to]) → 403"
call POST "/agents/${AGENT_BOB}/actions/send_email" "$ROOT_KEY" \
  '{"to":["user@gmail.com"],"subject":"Outreach","text":"..."}'
assert_http "Non-allowed domain → 403" 403
POLICY_MSG=$(jq_r "$HTTP_BODY" '.message')
assert_contains "Error mentions 'allowed_domains'" "$POLICY_MSG" "allowed_domains"
info "Reason: $POLICY_MSG"

step "Bob → Alice's @agentmail.to address  (in allowed_domains) → 200"
call POST "/agents/${AGENT_BOB}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" \
    '{"to":[$to],"subject":"Allowed outreach","text":"This domain is permitted."}')"
assert_http "Allowed domain → 200" 200

# ══════════════════════════════════════════════════════════════════════════════
section 6 "Auth & Permission Errors  ·  no free rides"
# ══════════════════════════════════════════════════════════════════════════════

step "No Authorization header → 401"
call GET /agents
assert_http "Missing auth → 401" 401

step "Garbage API key → 401"
call GET /agents "sk_FAKE.NOTAREALKEY123456"
assert_http "Invalid key → 401" 401

step "Service key cannot mint API keys  (lacks api_keys:write scope) → 403"
call POST "/orgs/${ORG_ID}/api-keys" "$SERVICE_KEY" '{"keyType":"service"}'
assert_http "Service key blocked from minting → 403" 403
info "Root key needed for admin operations"

step "Service key CAN list agents  (has agents:read) → 200"
call GET /agents "$SERVICE_KEY"
assert_http "Service key reads agents → 200" 200

step "Service key CAN create agents  (has agents:write) → 201"
call POST /agents "$SERVICE_KEY" '{"name":"service-key-created-agent"}'
assert_http "Service key creates agent → 201" 201
EPHEMERAL_AGENT=$(jq_r "$HTTP_BODY" '.agent.id')
info "Created: $EPHEMERAL_AGENT"

step "Cross-org key minting (root key from org A, route param = org B) → 403"
# Create a second org just to get its ID, then try to mint keys for it using org A's root key
call POST /orgs "" '{"name":"Another Corp"}'
assert_http "Create second org" 201
SECOND_ORG_ID=$(jq_r "$HTTP_BODY" '.org.id')
call POST "/orgs/${SECOND_ORG_ID}/api-keys" "$ROOT_KEY" '{"keyType":"service"}'
assert_http "Cannot mint keys for another org → 403" 403

# ══════════════════════════════════════════════════════════════════════════════
section 7 "Validation Errors  ·  Zod rejects bad input at ingress"
# ══════════════════════════════════════════════════════════════════════════════

step "GET /agents/:id — nonexistent ID → 404"
call GET "/agents/agt_doesnotexist_$(date +%s)" "$ROOT_KEY"
assert_http "Nonexistent agent → 404" 404

step "Send email from agent with no inbox → 404"
call POST "/agents/${EPHEMERAL_AGENT}/actions/send_email" "$ROOT_KEY" \
  '{"to":["x@example.com"],"subject":"No inbox","text":"..."}'
assert_http "No inbox → 404" 404
info "$(jq_r "$HTTP_BODY" '.message')"

step "Provision with blocked_domains as object (not array) → 400  [rejected at ingress by Zod]"
call POST "/agents/${AGENT_ALICE}/resources" "$ROOT_KEY" \
  '{"type":"email_inbox","provider":"agentmail","config":{"blocked_domains":{"evil":"yes"}}}'
assert_http "Invalid config type → 400" 400
info "$(jq_r "$HTTP_BODY" '.message')"

step "Create agent with empty name → 400"
call POST /agents "$ROOT_KEY" '{"name":""}'
assert_http "Empty name → 400" 400

step "Send email with missing required 'to' field → 400"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  '{"subject":"No to field","text":"..."}'
assert_http "Missing required field → 400" 400

# ══════════════════════════════════════════════════════════════════════════════
section 8 "Tenant Isolation  ·  hard org-scoped data walls"
# ══════════════════════════════════════════════════════════════════════════════

step "Create 'Attacker Corp' org"
call POST /orgs "" '{"name":"Attacker Corp"}'
assert_http "Create attacker org" 201
ATTACKER_ORG=$(jq_r "$HTTP_BODY" '.org.id')
ATTACKER_KEY=$(jq_r "$HTTP_BODY" '.apiKey.key')
require_var "attacker_org" "$ATTACKER_ORG"
info "Attacker org: $ATTACKER_ORG"

step "Attacker tries to read Demo Corp's agent → 404  (existence not leaked)"
call GET "/agents/${AGENT_ALICE}" "$ATTACKER_KEY"
assert_http "Cross-org GET agent → 404" 404
info "Returns 404, not 403 — org boundary is invisible to the caller"

step "Attacker tries to send email via Demo Corp's agent → 404"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ATTACKER_KEY" \
  '{"to":["victim@example.com"],"subject":"Hijack","text":"..."}'
assert_http "Cross-org send email → 404" 404

step "Attacker's GET /agents → 200, empty list (isolated)"
call GET /agents "$ATTACKER_KEY"
assert_http "Attacker sees own data only → 200" 200
ATTACKER_COUNT=$(jq_r "$HTTP_BODY" '.agents | length')
[[ "$ATTACKER_COUNT" -eq 0 ]] \
  && pass "0 agents (Demo Corp data invisible to Attacker Corp)" \
  || fail "Expected 0 agents for attacker, got $ATTACKER_COUNT"

step "Attacker tries to deprovision Demo Corp's resource → 404"
call DELETE "/agents/${AGENT_ALICE}/resources/${ALICE_RESOURCE_ID}" "$ATTACKER_KEY"
assert_http "Cross-org deprovision → 404" 404

# ══════════════════════════════════════════════════════════════════════════════
section 9 "Idempotency  ·  exactly-once event delivery"
# ══════════════════════════════════════════════════════════════════════════════

IDEM_KEY="demo-idempotent-key-$(date +%s)"

step "First send with idempotency_key"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" --arg k "$IDEM_KEY" \
    '{"to":[$to],"subject":"Idempotent send","text":"This fires once.","idempotency_key":$k}')"
assert_http "First send" 200
EVENT_ID_1=$(jq_r "$HTTP_BODY" '.event.id')
info "Event ID (call 1): $EVENT_ID_1"

step "Replay the exact same request  (same idempotency_key)"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" --arg k "$IDEM_KEY" \
    '{"to":[$to],"subject":"Idempotent send","text":"This fires once.","idempotency_key":$k}')"
assert_http "Replay (second call)" 200
EVENT_ID_2=$(jq_r "$HTTP_BODY" '.event.id')
info "Event ID (call 2): $EVENT_ID_2"

if [[ "$EVENT_ID_1" == "$EVENT_ID_2" ]]; then
  pass "Same event ID returned — idempotency key deduplicated (no double-send, no double-event)"
else
  fail "Different IDs returned — idempotency broken ($EVENT_ID_1 ≠ $EVENT_ID_2)"
fi

step "Different idempotency_key → new event  (not deduped)"
IDEM_KEY_2="demo-idempotent-key-$(date +%s)-b"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" --arg k "$IDEM_KEY_2" \
    '{"to":[$to],"subject":"Different send","text":"New key.","idempotency_key":$k}')"
assert_http "New key → new event" 200
EVENT_ID_3=$(jq_r "$HTTP_BODY" '.event.id')
[[ "$EVENT_ID_1" != "$EVENT_ID_3" ]] \
  && pass "Different key → different event ID (correct)" \
  || fail "Different keys returned same event ID (incorrect)"

# ══════════════════════════════════════════════════════════════════════════════
section 10 "Event Log  ·  queryable, filterable, cursor-paged"
# ══════════════════════════════════════════════════════════════════════════════

step "GET /agents/:id/events — Alice's full immutable log"
call GET "/agents/${AGENT_ALICE}/events" "$ROOT_KEY"
assert_http "Get full event log" 200
TOTAL_EVENTS=$(jq_r "$HTTP_BODY" '.events | length')
if [[ "$TOTAL_EVENTS" -gt 0 ]]; then
  pass "Event log has $TOTAL_EVENTS events"
else
  fail "Expected events in log"
fi
info "nextCursor: $(jq_r "$HTTP_BODY" '.nextCursor')"

step "GET …?type=email.sent — filter by event type"
call GET "/agents/${AGENT_ALICE}/events?type=email.sent" "$ROOT_KEY"
assert_http "Filter by type" 200
SENT_COUNT=$(jq_r "$HTTP_BODY" '.events | length')
ALL_CORRECT=$(echo "$HTTP_BODY" | jq -r 'if .events | length == 0 then "true" else [.events[].eventType == "email.sent"] | all end' 2>/dev/null)
if [[ "$ALL_CORRECT" == "true" && "$SENT_COUNT" -gt 0 ]]; then
  pass "Type filter: $SENT_COUNT email.sent events (no leakage of other types)"
elif [[ "$SENT_COUNT" -eq 0 ]]; then
  fail "Expected email.sent events, got 0"
else
  fail "Type filter returned non-email.sent events"
fi

step "GET …?limit=1 — cursor-based pagination"
call GET "/agents/${AGENT_ALICE}/events?limit=1" "$ROOT_KEY"
assert_http "Page 1 (limit=1)" 200
NEXT_CURSOR=$(jq_r "$HTTP_BODY" '.nextCursor')
P1_EVENT_ID=$(jq_r "$HTTP_BODY" '.events[0].id')

if [[ -n "$NEXT_CURSOR" && "$NEXT_CURSOR" != "null" ]]; then
  pass "nextCursor present — more pages available"

  step "GET page 2 using cursor"
  call GET "/agents/${AGENT_ALICE}/events?limit=1&cursor=${NEXT_CURSOR}" "$ROOT_KEY"
  assert_http "Page 2 via cursor" 200
  P2_EVENT_ID=$(jq_r "$HTTP_BODY" '.events[0].id')
  [[ "$P1_EVENT_ID" != "$P2_EVENT_ID" ]] \
    && pass "Page 2 contains different event (no duplication across pages)" \
    || fail "Pages returned the same event (pagination broken)"
else
  info "Alice has ≤1 event — pagination skipped"
fi

step "GET …?cursor=GARBAGE → 400  (malformed cursor rejected)"
call GET "/agents/${AGENT_ALICE}/events?cursor=NOTAVALIDCURSOR" "$ROOT_KEY"
assert_http "Invalid cursor → 400" 400

step "GET events for nonexistent agent → 404"
call GET "/agents/agt_ghost/events" "$ROOT_KEY"
assert_http "Ghost agent events → 404" 404

# ══════════════════════════════════════════════════════════════════════════════
section 11 "Agent Archival  ·  soft delete, history preserved"
# ══════════════════════════════════════════════════════════════════════════════

step "DELETE /agents/:id — soft-archive vault-relay"
call DELETE "/agents/${AGENT_VAULT}" "$ROOT_KEY"
assert_http "Archive vault" 200
IS_ARCHIVED=$(jq_r "$HTTP_BODY" '.agent.isArchived')
[[ "$IS_ARCHIVED" == "true" ]] \
  && pass "isArchived = true (soft delete — data preserved)" \
  || fail "Expected isArchived=true"

step "GET /agents — vault absent from default listing"
call GET /agents "$ROOT_KEY"
assert_http "Default list excludes archived" 200
VAULT_PRESENT=$(echo "$HTTP_BODY" | jq -r "[.agents[].id == \"$AGENT_VAULT\"] | any" 2>/dev/null)
[[ "$VAULT_PRESENT" == "false" ]] \
  && pass "Archived agent hidden from default list" \
  || fail "Archived agent visible in default list"

step "GET /agents?includeArchived=true — vault reappears"
call GET "/agents?includeArchived=true" "$ROOT_KEY"
assert_http "List with includeArchived=true" 200
VAULT_IN_FULL=$(echo "$HTTP_BODY" | jq -r "[.agents[].id == \"$AGENT_VAULT\"] | any" 2>/dev/null)
[[ "$VAULT_IN_FULL" == "true" ]] \
  && pass "Archived agent visible with includeArchived=true" \
  || fail "Archived agent not found with includeArchived=true"

step "Send email from archived agent → 404  (can't act on archived identity)"
call POST "/agents/${AGENT_VAULT}/actions/send_email" "$ROOT_KEY" \
  "$(jq -n --arg to "$ALICE_EMAIL" '{"to":[$to],"subject":"Ghost","text":"..."}')"
assert_http "Archived agent action → 404" 404

step "PATCH /agents/:id — restore vault-relay (un-archive for future runs)"
call PATCH "/agents/${AGENT_VAULT}" "$ROOT_KEY" '{"isArchived":false}'
assert_http "Un-archive vault" 200
IS_RESTORED=$(jq_r "$HTTP_BODY" '.agent.isArchived')
[[ "$IS_RESTORED" == "false" ]] \
  && pass "vault-relay restored (isArchived = false)" \
  || fail "Expected isArchived=false after restore"

# ══════════════════════════════════════════════════════════════════════════════
section 12 "Resource Deprovisioning  ·  clean teardown"
# ══════════════════════════════════════════════════════════════════════════════

step "DELETE /agents/:id/resources/:rid — deprovision Alice's inbox"
call DELETE "/agents/${AGENT_ALICE}/resources/${ALICE_RESOURCE_ID}" "$ROOT_KEY"
assert_http "Deprovision inbox" 200
DEPROVISIONED_STATE=$(jq_r "$HTTP_BODY" '.resource.state')
[[ "$DEPROVISIONED_STATE" == "deleted" ]] \
  && pass "Resource state → deleted" \
  || fail "Expected state=deleted, got $DEPROVISIONED_STATE"

step "GET /agents/:id/resources — no active resources"
call GET "/agents/${AGENT_ALICE}/resources" "$ROOT_KEY"
assert_http "List after deprovision" 200
ACTIVE_R=$(echo "$HTTP_BODY" | jq '[.resources[] | select(.state == "active")] | length' 2>/dev/null)
[[ "$ACTIVE_R" == "0" ]] \
  && pass "0 active resources (deprovision complete)" \
  || fail "Expected 0 active resources, found $ACTIVE_R"

step "Send email from Alice → 404  (inbox gone)"
call POST "/agents/${AGENT_ALICE}/actions/send_email" "$ROOT_KEY" \
  '{"to":["anyone@example.com"],"subject":"No inbox","text":"..."}'
assert_http "Send without inbox → 404" 404
info "$(jq_r "$HTTP_BODY" '.message')"

# Mark Alice's inbox for re-provisioning on the next run
ALICE_INBOX_NEEDS_REPROVISION=true
ALICE_RESOURCE_ID=""
ALICE_EMAIL=""
save_state
info "State saved — Alice's inbox will be re-provisioned on next run"

# ══════════════════════════════════════════════════════════════════════════════
#  RESULTS
# ══════════════════════════════════════════════════════════════════════════════
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Results${NC}"
echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo ""
printf "  %-14s %s\n"                        "Total checks:" "$TOTAL"
printf "  ${GREEN}%-14s ${BOLD}%s${NC}\n"    "Passed:"       "$PASS_COUNT"
printf "  ${RED}%-14s ${BOLD}%s${NC}\n"      "Failed:"       "$FAIL_COUNT"
echo ""

if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✓  All $TOTAL checks passed.${NC}"
  echo ""
  echo -e "  ${DIM}What just ran:${NC}"
  echo -e "  ${DIM}  • Org bootstrapped with root + service key${NC}"
  echo -e "  ${DIM}  • 3 agents provisioned with real AgentMail inboxes${NC}"
  echo -e "  ${DIM}  • Live emails sent between agents${NC}"
  echo -e "  ${DIM}  • Policy guardrails fired on 4 violation attempts${NC}"
  echo -e "  ${DIM}  • Auth rejected 3 unauthorized callers${NC}"
  echo -e "  ${DIM}  • Tenant isolation blocked all cross-org attempts${NC}"
  echo -e "  ${DIM}  • Idempotency key deduplicated a replayed send${NC}"
  echo -e "  ${DIM}  • Event log queried with type filter + cursor pagination${NC}"
  echo -e "  ${DIM}  • Agent archived + resource deprovisioned cleanly${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}  ✗  $FAIL_COUNT check(s) failed — see details above.${NC}"
  echo ""
  echo -e "  ${YELLOW}Common causes:${NC}"
  echo -e "  ${DIM}  • Server not started with AGENTMAIL_API_KEY + AGENTMAIL_WEBHOOK_SECRET${NC}"
  echo -e "  ${DIM}  • Database not running (docker compose up -d)${NC}"
  echo -e "  ${DIM}  • Migrations not applied (npm run db:migrate)${NC}"
  echo ""
  exit 1
fi
