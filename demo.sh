#!/usr/bin/env bash
# AgentConnect Phase D demo
#
# Story:
#   One agent identity can own multiple real-world rails. In this demo a single
#   agent gets an email inbox and a virtual card, produces canonical events on
#   both rails, and ends with a unified timeline query.
#
# Full local demo:
#   source .env
#   npm run dev
#   source .env
#   ./demo.sh
#
# Notes:
#   - AgentMail must be configured on the server for the email path.
#   - Card issuance uses the server's configured Stripe adapter.
#   - If STRIPE_WEBHOOK_SECRET is exported in this shell, the script also
#     simulates signed Stripe authorization and settlement webhooks.
#   - Set DEMO_SKIP_CARD=1 to run an email-only version.

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
STATE_FILE="${STATE_FILE:-.demo-state}"
STATE_VERSION="phase-d-v1"
RUN_TAG="${RUN_TAG:-$(date '+%Y%m%d-%H%M%S')}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
SKIP_NOTES=()

pass() {
  echo -e "  ${GREEN}[OK]${NC} $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}[FAIL]${NC} $*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

skip() {
  echo -e "  ${YELLOW}[SKIP]${NC} $*"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  SKIP_NOTES+=("$*")
}

warn() {
  echo -e "  ${YELLOW}[WARN]${NC} $*"
}

info() {
  echo -e "  ${DIM}$*${NC}"
}

step() {
  echo -e "\n  ${CYAN}>${NC} $*"
}

abort() {
  echo -e "\n${RED}FATAL:${NC} $*\n"
  exit 1
}

section() {
  echo ""
  echo -e "${BOLD}${BLUE}------------------------------------------------------------${NC}"
  echo -e "${BOLD}${BLUE}$1${NC}"
  echo -e "${BOLD}${BLUE}------------------------------------------------------------${NC}"
}

mask() {
  local value="$1"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "null"
    return
  fi

  if [[ "${#value}" -le 12 ]]; then
    echo "${value:0:4}..."
    return
  fi

  echo "${value:0:10}..."
}

json_peek() {
  echo "$1" | jq '.' 2>/dev/null | head -10 | while IFS= read -r line; do
    echo -e "  ${DIM}${line}${NC}"
  done
}

jq_r() {
  echo "$1" | jq -r "$2" 2>/dev/null
}

require_var() {
  if [[ -z "$2" || "$2" == "null" ]]; then
    abort "Could not extract $1 from the last response"
  fi
}

is_truthy() {
  case "$1" in
    1 | true | TRUE | yes | YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

active_resource_present() {
  echo "$1" | jq -e --arg rid "$2" '.resources[]? | select(.id == $rid and .state == "active")' \
    >/dev/null 2>&1
}

_TMP="$(mktemp)"
trap 'rm -f "$_TMP"' EXIT

HTTP_STATUS=""
HTTP_BODY=""

call_raw() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3 || true

  local -a args=(
    -s
    -o "$_TMP"
    -w "%{http_code}"
    -X "$method"
    "${BASE_URL}${path}"
  )

  while [[ "$#" -gt 0 ]]; do
    args+=(-H "$1")
    shift
  done

  if [[ -n "$body" ]]; then
    args+=(--data "$body")
  fi

  HTTP_STATUS="$(curl "${args[@]}" 2>/dev/null || echo "000")"
  HTTP_BODY="$(cat "$_TMP" 2>/dev/null || echo "{}")"
}

call() {
  local method="$1"
  local path="$2"
  local auth="${3:-}"
  local body="${4:-}"

  if [[ -n "$body" && -n "$auth" ]]; then
    call_raw "$method" "$path" "$body" \
      "Authorization: Bearer $auth" \
      "Content-Type: application/json"
  elif [[ -n "$body" ]]; then
    call_raw "$method" "$path" "$body" "Content-Type: application/json"
  elif [[ -n "$auth" ]]; then
    call_raw "$method" "$path" "" "Authorization: Bearer $auth"
  else
    call_raw "$method" "$path" ""
  fi
}

assert_http() {
  local label="$1"
  local expected="$2"
  if [[ "$HTTP_STATUS" == "$expected" ]]; then
    pass "HTTP $HTTP_STATUS - $label"
  else
    fail "HTTP $HTTP_STATUS (expected $expected) - $label"
    local message
    message="$(jq_r "$HTTP_BODY" '.message // empty')"
    if [[ -n "$message" ]]; then
      info "message: $message"
    fi
  fi
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  if echo "$haystack" | grep -qi "$needle" 2>/dev/null; then
    pass "$label"
  else
    fail "$label (expected to contain '$needle')"
  fi
}

reset_state() {
  ORG_ID=""
  ROOT_KEY=""
  SERVICE_KEY=""
  AGENT_CONCIERGE=""
  AGENT_APPROVER=""
  CONCIERGE_EMAIL_RESOURCE_ID=""
  CONCIERGE_EMAIL=""
  APPROVER_EMAIL_RESOURCE_ID=""
  APPROVER_EMAIL=""
}

save_state() {
  cat >"$STATE_FILE" <<STATEFILE
DEMO_STATE_VERSION="${STATE_VERSION}"
SAVED_BASE_URL="${BASE_URL}"
ORG_ID="${ORG_ID:-}"
ROOT_KEY="${ROOT_KEY:-}"
SERVICE_KEY="${SERVICE_KEY:-}"
AGENT_CONCIERGE="${AGENT_CONCIERGE:-}"
AGENT_APPROVER="${AGENT_APPROVER:-}"
CONCIERGE_EMAIL_RESOURCE_ID="${CONCIERGE_EMAIL_RESOURCE_ID:-}"
CONCIERGE_EMAIL="${CONCIERGE_EMAIL:-}"
APPROVER_EMAIL_RESOURCE_ID="${APPROVER_EMAIL_RESOURCE_ID:-}"
APPROVER_EMAIL="${APPROVER_EMAIL:-}"
STATEFILE
}

stripe_signature() {
  local secret="$1"
  local timestamp="$2"
  local payload="$3"

  printf '%s.%s' "$timestamp" "$payload" \
    | openssl dgst -sha256 -hmac "$secret" \
    | awk '{print $NF}'
}

post_stripe_webhook() {
  local payload="$1"
  local timestamp
  local signature

  timestamp="$(date +%s)"
  signature="$(stripe_signature "$STRIPE_WEBHOOK_SECRET" "$timestamp" "$payload")"
  call_raw POST /webhooks/stripe "$payload" \
    "Content-Type: application/json" \
    "stripe-signature: t=${timestamp},v1=${signature}"
}

echo ""
echo -e "${BOLD}${BLUE}"
cat <<'BANNER'
  AgentConnect Phase D Demo
  One agent identity. Multiple rails. One timeline.
BANNER
echo -e "${NC}"
echo -e "  Target: ${CYAN}${BASE_URL}${NC}"
echo -e "  Run:    ${RUN_TAG}"
echo ""

for dep in curl jq; do
  if command -v "$dep" >/dev/null 2>&1; then
    echo -e "  ${GREEN}[OK]${NC} $dep"
  else
    abort "$dep not found"
  fi
done

if [[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    echo -e "  ${GREEN}[OK]${NC} openssl"
  else
    warn "openssl not found - signed Stripe webhook simulation will be skipped"
  fi
fi

step "Health check"
call GET /health
if [[ "$HTTP_STATUS" != "200" ]]; then
  abort "Server not responding at ${BASE_URL}. Start it with: source .env && npm run dev"
fi
pass "Server is up"

reset_state
STATE_LOADED=false

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"

  if [[ "${DEMO_STATE_VERSION:-}" != "$STATE_VERSION" ]]; then
    warn "State file version changed; starting fresh"
    rm -f "$STATE_FILE"
    reset_state
  elif [[ "${SAVED_BASE_URL:-}" != "$BASE_URL" ]]; then
    warn "State file belongs to ${SAVED_BASE_URL:-unknown}; starting fresh"
    rm -f "$STATE_FILE"
    reset_state
  elif [[ -n "${ORG_ID:-}" && -n "${AGENT_CONCIERGE:-}" && -n "${ROOT_KEY:-}" ]]; then
    step "Validating saved state"
    call GET "/agents/${AGENT_CONCIERGE}" "$ROOT_KEY"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      pass "Saved org, keys, and hero agent are still valid"
      STATE_LOADED=true
    else
      warn "Saved state is stale; starting fresh"
      rm -f "$STATE_FILE"
      reset_state
    fi
  fi
fi

section "1. Control Plane Bootstrap"

if [[ -z "$ORG_ID" ]]; then
  step "Create demo org"
  call POST /orgs "" '{"name":"Phase D Demo Org"}'
  assert_http "Create org" 201
  ORG_PREVIEW="$(echo "$HTTP_BODY" | jq '.apiKey.key = "***redacted***"')"
  json_peek "$ORG_PREVIEW"

  ORG_ID="$(jq_r "$HTTP_BODY" '.org.id')"
  ROOT_KEY="$(jq_r "$HTTP_BODY" '.apiKey.key')"
  require_var "org_id" "$ORG_ID"
  require_var "root_key" "$ROOT_KEY"
  info "org_id:   $ORG_ID"
  info "root_key: $(mask "$ROOT_KEY")"

  step "Create scoped service key"
  call POST "/orgs/${ORG_ID}/api-keys" "$ROOT_KEY"
  assert_http "Create service key" 201
  SERVICE_KEY="$(jq_r "$HTTP_BODY" '.apiKey.key')"
  require_var "service_key" "$SERVICE_KEY"
  info "service_key: $(mask "$SERVICE_KEY")"

  save_state
else
  step "Using saved org and keys"
  info "org_id:      $ORG_ID"
  info "root_key:    $(mask "$ROOT_KEY")"
  info "service_key: $(mask "$SERVICE_KEY")"
fi

step "Service key can read org-scoped agent data"
call GET /agents "$SERVICE_KEY"
assert_http "Service key reads agents" 200

step "Service key cannot mint more API keys"
call POST "/orgs/${ORG_ID}/api-keys" "$SERVICE_KEY"
assert_http "Service key blocked from admin key creation" 403

section "2. Agent Identity and Email Rail"

if [[ -z "$AGENT_CONCIERGE" ]]; then
  step "Create hero agent: concierge-agent"
  call POST /agents "$ROOT_KEY" '{"name":"concierge-agent"}'
  assert_http "Create concierge agent" 201
  AGENT_CONCIERGE="$(jq_r "$HTTP_BODY" '.agent.id')"
  require_var "agent_concierge" "$AGENT_CONCIERGE"
  info "concierge_agent: $AGENT_CONCIERGE"
else
  step "Using saved hero agent"
  info "concierge_agent: $AGENT_CONCIERGE"
fi

if [[ -z "$AGENT_APPROVER" ]]; then
  step "Create counterpart agent: ops-approver"
  call POST /agents "$ROOT_KEY" '{"name":"ops-approver"}'
  assert_http "Create approver agent" 201
  AGENT_APPROVER="$(jq_r "$HTTP_BODY" '.agent.id')"
  require_var "agent_approver" "$AGENT_APPROVER"
  info "approver_agent:  $AGENT_APPROVER"
else
  step "Using saved counterpart agent"
  info "approver_agent: $AGENT_APPROVER"
fi

save_state

step "List agents"
call GET /agents "$ROOT_KEY"
assert_http "List agents" 200
AGENT_COUNT="$(jq_r "$HTTP_BODY" '.agents | length')"
if [[ "$AGENT_COUNT" -ge 2 ]]; then
  pass "Org currently has $AGENT_COUNT visible agents"
else
  fail "Expected at least 2 agents, got $AGENT_COUNT"
fi

if [[ -n "$CONCIERGE_EMAIL_RESOURCE_ID" ]]; then
  step "Validate saved concierge inbox"
  call GET "/agents/${AGENT_CONCIERGE}/resources" "$ROOT_KEY"
  if [[ "$HTTP_STATUS" == "200" ]] && active_resource_present "$HTTP_BODY" "$CONCIERGE_EMAIL_RESOURCE_ID"; then
    CONCIERGE_EMAIL="$(echo "$HTTP_BODY" | jq -r --arg rid "$CONCIERGE_EMAIL_RESOURCE_ID" '.resources[] | select(.id == $rid) | .providerRef')"
    pass "Saved concierge inbox is still active"
  else
    warn "Saved concierge inbox missing; re-provisioning"
    CONCIERGE_EMAIL_RESOURCE_ID=""
    CONCIERGE_EMAIL=""
  fi
fi

if [[ -z "$CONCIERGE_EMAIL_RESOURCE_ID" ]]; then
  step "Provision concierge email inbox with send policy"
  call POST "/agents/${AGENT_CONCIERGE}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{"blocked_domains":["competitor.com"],"max_recipients":3}}'

  if [[ "$HTTP_STATUS" == "201" ]]; then
    pass "HTTP 201 - Concierge inbox provisioned"
  else
    local_message="$(jq_r "$HTTP_BODY" '.message // empty')"
    if [[ "$HTTP_STATUS" == "404" && "$local_message" == *"No adapter for provider: agentmail"* ]]; then
      abort "AgentMail adapter not configured on the server. Start with: source .env && npm run dev"
    fi
    fail "HTTP $HTTP_STATUS (expected 201) - Concierge inbox provisioned"
    [[ -n "$local_message" ]] && info "message: $local_message"
    abort "Cannot continue without an email inbox"
  fi

  CONCIERGE_EMAIL_RESOURCE_ID="$(jq_r "$HTTP_BODY" '.resource.id')"
  CONCIERGE_EMAIL="$(jq_r "$HTTP_BODY" '.resource.providerRef')"
  require_var "concierge_email_resource_id" "$CONCIERGE_EMAIL_RESOURCE_ID"
  require_var "concierge_email" "$CONCIERGE_EMAIL"
  info "concierge inbox: $CONCIERGE_EMAIL"
fi

if [[ -n "$APPROVER_EMAIL_RESOURCE_ID" ]]; then
  step "Validate saved approver inbox"
  call GET "/agents/${AGENT_APPROVER}/resources" "$ROOT_KEY"
  if [[ "$HTTP_STATUS" == "200" ]] && active_resource_present "$HTTP_BODY" "$APPROVER_EMAIL_RESOURCE_ID"; then
    APPROVER_EMAIL="$(echo "$HTTP_BODY" | jq -r --arg rid "$APPROVER_EMAIL_RESOURCE_ID" '.resources[] | select(.id == $rid) | .providerRef')"
    pass "Saved approver inbox is still active"
  else
    warn "Saved approver inbox missing; re-provisioning"
    APPROVER_EMAIL_RESOURCE_ID=""
    APPROVER_EMAIL=""
  fi
fi

if [[ -z "$APPROVER_EMAIL_RESOURCE_ID" ]]; then
  step "Provision approver inbox"
  call POST "/agents/${AGENT_APPROVER}/resources" "$ROOT_KEY" \
    '{"type":"email_inbox","provider":"agentmail","config":{}}'

  if [[ "$HTTP_STATUS" == "201" ]]; then
    pass "HTTP 201 - Approver inbox provisioned"
  else
    local_message="$(jq_r "$HTTP_BODY" '.message // empty')"
    if [[ "$HTTP_STATUS" == "404" && "$local_message" == *"No adapter for provider: agentmail"* ]]; then
      abort "AgentMail adapter not configured on the server. Start with: source .env && npm run dev"
    fi
    fail "HTTP $HTTP_STATUS (expected 201) - Approver inbox provisioned"
    [[ -n "$local_message" ]] && info "message: $local_message"
    abort "Cannot continue without a counterpart inbox"
  fi

  APPROVER_EMAIL_RESOURCE_ID="$(jq_r "$HTTP_BODY" '.resource.id')"
  APPROVER_EMAIL="$(jq_r "$HTTP_BODY" '.resource.providerRef')"
  require_var "approver_email_resource_id" "$APPROVER_EMAIL_RESOURCE_ID"
  require_var "approver_email" "$APPROVER_EMAIL"
  info "approver inbox:  $APPROVER_EMAIL"
fi

save_state

step "Hero agent now has an active inbox"
call GET "/agents/${AGENT_CONCIERGE}/resources" "$ROOT_KEY"
assert_http "List concierge resources" 200
EMAIL_ACTIVE_COUNT="$(echo "$HTTP_BODY" | jq -r '[.resources[] | select(.type == "email_inbox" and .state == "active")] | length')"
if [[ "$EMAIL_ACTIVE_COUNT" -ge 1 ]]; then
  pass "Concierge has $EMAIL_ACTIVE_COUNT active email resource(s)"
else
  fail "Expected an active email resource for concierge"
fi

EMAIL_SUBJECT="Phase D live email ${RUN_TAG}"

step "Send a live email from concierge-agent to ops-approver"
EMAIL_REQUEST="$(jq -nc \
  --arg to "$APPROVER_EMAIL" \
  --arg subject "$EMAIL_SUBJECT" \
  --arg text "This is the live multi-rail demo path." \
  '{"to":[$to],"subject":$subject,"text":$text}')"
call POST "/agents/${AGENT_CONCIERGE}/actions/send_email" "$ROOT_KEY" "$EMAIL_REQUEST"
assert_http "Send email" 200

EMAIL_EVENT_ID="$(jq_r "$HTTP_BODY" '.event.id')"
EMAIL_EVENT_TYPE="$(jq_r "$HTTP_BODY" '.event.eventType')"
EMAIL_THREAD_ID="$(jq_r "$HTTP_BODY" '.event.data.thread_id // null')"
if [[ "$EMAIL_EVENT_TYPE" == "email.sent" ]]; then
  pass "Canonical email event written as email.sent"
else
  fail "Expected email.sent, got $EMAIL_EVENT_TYPE"
fi
info "email_event_id: $EMAIL_EVENT_ID"
info "thread_id:      $EMAIL_THREAD_ID"

step "Policy blocks a send before any provider call escapes"
call POST "/agents/${AGENT_CONCIERGE}/actions/send_email" "$ROOT_KEY" \
  '{"to":["pilot@competitor.com"],"subject":"Blocked","text":"This should be denied."}'
assert_http "Blocked domain denied" 403
assert_contains "Policy error mentions blocked_domains" "$(jq_r "$HTTP_BODY" '.message')" "blocked"

section "3. Card Rail and One-Time Sensitive Data"

CARD_DEMO_RAN=false
CARD_WEBHOOKS_RECORDED=false
CARD_RESOURCE_ID=""
CARD_PROVIDER_REF=""
CARD_EVENT_ID=""
CARD_LAST4=""
AUTHORIZATION_ID=""
TRANSACTION_ID=""

if is_truthy "${DEMO_SKIP_CARD:-0}"; then
  skip "DEMO_SKIP_CARD requested; card issuance and card-backed timeline checks are disabled"
else
  step "Generic resource creation is intentionally rejected for Stripe cards"
  call POST "/agents/${AGENT_CONCIERGE}/resources" "$ROOT_KEY" \
    '{"type":"card","provider":"stripe","config":{}}'
  assert_http "Cards must be issued via the explicit action endpoint" 400
  assert_contains "Error points callers to /actions/issue_card" "$(jq_r "$HTTP_BODY" '.message')" "issue_card"

  CARD_IDEMPOTENCY_KEY="demo-card-${RUN_TAG}"
  CARD_REQUEST="$(jq -nc \
    --arg idem "$CARD_IDEMPOTENCY_KEY" \
    '{"spending_limits":[{"amount":25000,"interval":"daily"}],"allowed_merchant_countries":["US"],"idempotency_key":$idem}')"

  step "Issue a virtual card for the same agent identity"
  call POST "/agents/${AGENT_CONCIERGE}/actions/issue_card" "$ROOT_KEY" "$CARD_REQUEST"

  if [[ "$HTTP_STATUS" == "200" ]]; then
    pass "HTTP 200 - Card issued"
    CARD_DEMO_RAN=true
    CARD_RESOURCE_ID="$(jq_r "$HTTP_BODY" '.resource.id')"
    CARD_PROVIDER_REF="$(jq_r "$HTTP_BODY" '.resource.providerRef')"
    CARD_EVENT_ID="$(jq_r "$HTTP_BODY" '.event.id')"
    CARD_LAST4="$(jq_r "$HTTP_BODY" '.card.last4')"
    CARD_EVENT_TYPE="$(jq_r "$HTTP_BODY" '.event.eventType')"
    CARD_NUMBER="$(jq_r "$HTTP_BODY" '.card.number // null')"
    CARD_CVC="$(jq_r "$HTTP_BODY" '.card.cvc // null')"
    CARD_EXP_MONTH="$(jq_r "$HTTP_BODY" '.card.exp_month')"
    CARD_EXP_YEAR="$(jq_r "$HTTP_BODY" '.card.exp_year')"

    require_var "card_resource_id" "$CARD_RESOURCE_ID"
    require_var "card_provider_ref" "$CARD_PROVIDER_REF"

    if [[ "$CARD_EVENT_TYPE" == "payment.card.issued" ]]; then
      pass "Canonical card issuance event written as payment.card.issued"
    else
      fail "Expected payment.card.issued, got $CARD_EVENT_TYPE"
    fi

    if [[ "$CARD_PROVIDER_REF" == ic_* ]]; then
      pass "Stripe card providerRef stored as $CARD_PROVIDER_REF"
    else
      fail "Expected Stripe providerRef to start with ic_, got $CARD_PROVIDER_REF"
    fi

    if [[ "$CARD_NUMBER" != "null" && "$CARD_CVC" != "null" ]]; then
      pass "PAN and CVC returned once to the caller"
    else
      fail "Expected card number and CVC on first issuance response"
    fi

    CARD_CONFIG_HAS_NUMBER="$(echo "$HTTP_BODY" | jq -r '.resource.config | has("number")')"
    CARD_CONFIG_HAS_CVC="$(echo "$HTTP_BODY" | jq -r '.resource.config | has("cvc")')"
    if [[ "$CARD_CONFIG_HAS_NUMBER" == "false" && "$CARD_CONFIG_HAS_CVC" == "false" ]]; then
      pass "Stored resource config excludes PAN and CVC"
    else
      fail "Sensitive card fields leaked into resource config"
    fi

    info "card resource:  $CARD_RESOURCE_ID"
    info "provider_ref:   $CARD_PROVIDER_REF"
    info "card last4:     $CARD_LAST4"
    info "expiry:         ${CARD_EXP_MONTH}/${CARD_EXP_YEAR}"

    step "Replay the same issue_card request with the same idempotency key"
    call POST "/agents/${AGENT_CONCIERGE}/actions/issue_card" "$ROOT_KEY" "$CARD_REQUEST"
    assert_http "Idempotent card replay" 200

    REPLAY_RESOURCE_ID="$(jq_r "$HTTP_BODY" '.resource.id')"
    REPLAY_EVENT_ID="$(jq_r "$HTTP_BODY" '.event.id')"
    REPLAY_NUMBER="$(jq_r "$HTTP_BODY" '.card.number // null')"
    REPLAY_CVC="$(jq_r "$HTTP_BODY" '.card.cvc // null')"

    if [[ "$REPLAY_RESOURCE_ID" == "$CARD_RESOURCE_ID" && "$REPLAY_EVENT_ID" == "$CARD_EVENT_ID" ]]; then
      pass "Replay returned the same resource and event"
    else
      fail "Replay did not return the same card issuance record"
    fi

    if [[ "$REPLAY_NUMBER" == "null" && "$REPLAY_CVC" == "null" ]]; then
      pass "Sensitive card data is not replayed after the first successful response"
    else
      fail "Replay unexpectedly returned PAN or CVC"
    fi

    step "Hero agent now spans both email and card rails"
    call GET "/agents/${AGENT_CONCIERGE}/resources" "$ROOT_KEY"
    assert_http "List hero resources" 200
    HERO_RESOURCE_TYPES="$(echo "$HTTP_BODY" | jq -r '[.resources[].type] | join(", ")')"
    info "resource types: ${HERO_RESOURCE_TYPES}"
    HERO_RESOURCE_COUNT="$(jq_r "$HTTP_BODY" '.resources | length')"
    if [[ "$HERO_RESOURCE_COUNT" -ge 2 ]]; then
      pass "Hero agent has both rails attached"
    else
      fail "Expected at least 2 active resources for hero agent"
    fi
  else
    CARD_MESSAGE="$(jq_r "$HTTP_BODY" '.message // empty')"
    if [[ "$HTTP_STATUS" == "500" && "$CARD_MESSAGE" == "Stripe adapter not configured" ]]; then
      skip "Stripe adapter is not configured on the server; card issuance and card-backed timeline checks are skipped"
    else
      fail "HTTP $HTTP_STATUS (expected 200) - Card issued"
      [[ -n "$CARD_MESSAGE" ]] && info "message: $CARD_MESSAGE"
    fi
  fi
fi

if [[ "$CARD_DEMO_RAN" == "true" ]]; then
  section "4. Stripe Webhooks Become Canonical Card Activity"

  if [[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
    skip "STRIPE_WEBHOOK_SECRET is not exported in this shell; signed Stripe webhook simulation skipped"
  elif ! command -v openssl >/dev/null 2>&1; then
    skip "openssl is unavailable; signed Stripe webhook simulation skipped"
  else
    ID_STAMP="$(date +%s)$$"
    AUTHORIZATION_ID="iauth_demo_${ID_STAMP}"
    TRANSACTION_ID="ipi_demo_${ID_STAMP}"
    AUTH_EVENT_ID="evt_demo_auth_${ID_STAMP}"
    TXN_EVENT_ID="evt_demo_txn_${ID_STAMP}"
    CREATED_AT="$(date +%s)"

    AUTH_PAYLOAD="$(jq -nc \
      --arg event_id "$AUTH_EVENT_ID" \
      --arg auth_id "$AUTHORIZATION_ID" \
      --arg card_id "$CARD_PROVIDER_REF" \
      --argjson created "$CREATED_AT" \
      '{"id":$event_id,"type":"issuing_authorization.created","created":$created,"data":{"object":{"id":$auth_id,"card":{"id":$card_id},"approved":true,"amount":4200,"currency":"usd"}}}')"

    step "Simulate signed Stripe authorization webhook"
    post_stripe_webhook "$AUTH_PAYLOAD"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      pass "Signed authorization webhook accepted"
    elif [[ "$HTTP_STATUS" == "401" ]]; then
      skip "Stripe webhook signature failed; local STRIPE_WEBHOOK_SECRET does not match the server"
    else
      fail "HTTP $HTTP_STATUS (expected 200) - Authorization webhook accepted"
      WEBHOOK_MESSAGE="$(jq_r "$HTTP_BODY" '.message // empty')"
      [[ -n "$WEBHOOK_MESSAGE" ]] && info "message: $WEBHOOK_MESSAGE"
    fi

    if [[ "$HTTP_STATUS" == "200" ]]; then
      TXN_PAYLOAD="$(jq -nc \
        --arg event_id "$TXN_EVENT_ID" \
        --arg txn_id "$TRANSACTION_ID" \
        --arg auth_id "$AUTHORIZATION_ID" \
        --arg card_id "$CARD_PROVIDER_REF" \
        --argjson created "$((CREATED_AT + 1))" \
        '{"id":$event_id,"type":"issuing_transaction.created","created":$created,"data":{"object":{"id":$txn_id,"card":$card_id,"authorization":$auth_id,"amount":4200,"currency":"usd"}}}')"

      step "Simulate signed Stripe settlement webhook"
      post_stripe_webhook "$TXN_PAYLOAD"
      assert_http "Signed settlement webhook accepted" 200

      if [[ "$HTTP_STATUS" == "200" ]]; then
        step "Query canonical card events"
        call GET "/agents/${AGENT_CONCIERGE}/events?type=payment.card.authorized" "$ROOT_KEY"
        assert_http "Authorized event query" 200
        AUTH_MATCHED="$(echo "$HTTP_BODY" | jq -r --arg auth "$AUTHORIZATION_ID" '[.events[].data.authorization_id == $auth] | any')"
        if [[ "$AUTH_MATCHED" == "true" ]]; then
          pass "Authorization webhook became payment.card.authorized"
        else
          fail "Could not find authorized event for $AUTHORIZATION_ID"
        fi

        call GET "/agents/${AGENT_CONCIERGE}/events?type=payment.card.settled" "$ROOT_KEY"
        assert_http "Settled event query" 200
        TXN_MATCHED="$(echo "$HTTP_BODY" | jq -r --arg txn "$TRANSACTION_ID" '[.events[].data.transaction_id == $txn] | any')"
        if [[ "$TXN_MATCHED" == "true" ]]; then
          pass "Settlement webhook became payment.card.settled"
          CARD_WEBHOOKS_RECORDED=true
        else
          fail "Could not find settled event for $TRANSACTION_ID"
        fi
      fi
    fi
  fi
fi

section "5. Canonical Event Log and Unified Timeline"

step "Full event log for the hero agent"
call GET "/agents/${AGENT_CONCIERGE}/events" "$ROOT_KEY"
assert_http "List hero events" 200
EVENT_TOTAL="$(jq_r "$HTTP_BODY" '.events | length')"
if [[ "$EVENT_TOTAL" -ge 1 ]]; then
  pass "Hero agent has $EVENT_TOTAL canonical event(s)"
else
  fail "Expected at least one event for the hero agent"
fi
EVENT_TYPES="$(echo "$HTTP_BODY" | jq -r '[.events[].eventType] | unique | join(", ")')"
info "event types: ${EVENT_TYPES}"

if [[ "$CARD_WEBHOOKS_RECORDED" == "true" ]]; then
  step "Filter the event log to a single canonical card event type"
  call GET "/agents/${AGENT_CONCIERGE}/events?type=payment.card.authorized" "$ROOT_KEY"
  assert_http "Filter authorized events" 200
  FILTER_COUNT="$(jq_r "$HTTP_BODY" '.events | length')"
  if [[ "$FILTER_COUNT" -ge 1 ]]; then
    pass "Card event filter returns authorized events only"
  else
    fail "Expected at least one authorized event"
  fi
elif [[ "$CARD_DEMO_RAN" == "true" ]]; then
  step "Filter the event log to card issuance"
  call GET "/agents/${AGENT_CONCIERGE}/events?type=payment.card.issued" "$ROOT_KEY"
  assert_http "Filter issued card events" 200
  FILTER_COUNT="$(jq_r "$HTTP_BODY" '.events | length')"
  if [[ "$FILTER_COUNT" -ge 1 ]]; then
    pass "Card issuance is queryable as a canonical event type"
  else
    fail "Expected at least one payment.card.issued event"
  fi
else
  step "Filter the event log to email sends"
  call GET "/agents/${AGENT_CONCIERGE}/events?type=email.sent" "$ROOT_KEY"
  assert_http "Filter email.sent events" 200
  FILTER_COUNT="$(jq_r "$HTTP_BODY" '.events | length')"
  if [[ "$FILTER_COUNT" -ge 1 ]]; then
    pass "Email sends are queryable as canonical events"
  else
    fail "Expected at least one email.sent event"
  fi
fi

step "Read the unified timeline for the same agent identity"
call GET "/agents/${AGENT_CONCIERGE}/timeline" "$ROOT_KEY"
assert_http "Read hero timeline" 200
TIMELINE_ITEM_COUNT="$(jq_r "$HTTP_BODY" '.items | length')"
TIMELINE_KINDS="$(echo "$HTTP_BODY" | jq -r '[.items[].kind] | unique | join(", ")')"
if [[ "$TIMELINE_ITEM_COUNT" -ge 1 ]]; then
  pass "Timeline returned $TIMELINE_ITEM_COUNT item(s)"
else
  fail "Expected at least one timeline item"
fi
info "timeline kinds: ${TIMELINE_KINDS}"

EMAIL_TIMELINE_PRESENT="$(echo "$HTTP_BODY" | jq -r '[.items[].kind == "email_thread"] | any')"
if [[ "$EMAIL_TIMELINE_PRESENT" == "true" ]]; then
  pass "Timeline includes an email_thread item"
else
  fail "Expected an email_thread item on the timeline"
fi

if [[ "$CARD_WEBHOOKS_RECORDED" == "true" ]]; then
  CARD_TIMELINE_PRESENT="$(echo "$HTTP_BODY" | jq -r '[.items[].kind == "card_activity"] | any')"
  if [[ "$CARD_TIMELINE_PRESENT" == "true" ]]; then
    pass "Timeline includes grouped card_activity"
    CARD_TIMELINE_EVENT_COUNT="$(echo "$HTTP_BODY" | jq -r '[.items[] | select(.kind == "card_activity")][0].eventCount')"
    if [[ "$CARD_TIMELINE_EVENT_COUNT" -ge 2 ]]; then
      pass "Card timeline item groups authorization and settlement together"
    else
      fail "Expected grouped card activity with at least 2 events"
    fi
  else
    fail "Expected a card_activity item on the timeline"
  fi
elif [[ "$CARD_DEMO_RAN" == "true" ]]; then
  CARD_ISSUED_PRESENT="$(echo "$HTTP_BODY" | jq -r '[.items[].latestEventType == "payment.card.issued"] | any')"
  if [[ "$CARD_ISSUED_PRESENT" == "true" ]]; then
    pass "Timeline already includes card issuance even without webhook playback"
  else
    fail "Expected payment.card.issued to appear on the timeline"
  fi
fi

step "Service key can page through the timeline with an opaque cursor"
call GET "/agents/${AGENT_CONCIERGE}/timeline?limit=1" "$SERVICE_KEY"
assert_http "Service key reads first timeline page" 200
PAGE_ONE_ID="$(jq_r "$HTTP_BODY" '.items[0].id // null')"
NEXT_CURSOR="$(jq_r "$HTTP_BODY" '.nextCursor // null')"
if [[ -n "$NEXT_CURSOR" && "$NEXT_CURSOR" != "null" ]]; then
  call GET "/agents/${AGENT_CONCIERGE}/timeline?limit=1&cursor=${NEXT_CURSOR}" "$SERVICE_KEY"
  assert_http "Service key reads second timeline page" 200
  PAGE_TWO_ID="$(jq_r "$HTTP_BODY" '.items[0].id // null')"
  if [[ "$PAGE_ONE_ID" != "null" && "$PAGE_TWO_ID" != "null" && "$PAGE_ONE_ID" != "$PAGE_TWO_ID" ]]; then
    pass "Opaque cursor advances to a different timeline item"
  else
    fail "Expected a different item on the second timeline page"
  fi
else
  skip "Timeline pagination needs at least 2 items; current run produced a single visible page"
fi

section "6. Multi-Tenant Isolation"

step "Create a second org to test org boundaries"
call POST /orgs "" '{"name":"Shadow Org"}'
assert_http "Create second org" 201
ATTACKER_KEY="$(jq_r "$HTTP_BODY" '.apiKey.key')"
require_var "attacker_key" "$ATTACKER_KEY"

step "Cross-org reads do not leak agent existence"
call GET "/agents/${AGENT_CONCIERGE}" "$ATTACKER_KEY"
assert_http "Other org cannot read hero agent" 404

step "Cross-org timeline reads are also blocked"
call GET "/agents/${AGENT_CONCIERGE}/timeline" "$ATTACKER_KEY"
assert_http "Other org cannot read hero timeline" 404

if [[ "$CARD_DEMO_RAN" == "true" && -n "$CARD_RESOURCE_ID" ]]; then
  section "7. Cleanup"

  step "Delete the demo card so reruns stay tidy"
  call DELETE "/agents/${AGENT_CONCIERGE}/resources/${CARD_RESOURCE_ID}" "$ROOT_KEY"
  assert_http "Delete card resource" 200
  if [[ "$(jq_r "$HTTP_BODY" '.resource.state')" == "deleted" ]]; then
    pass "Card resource marked deleted"
  else
    fail "Expected deleted card resource state"
  fi
fi

TOTAL_CHECKS=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))

echo ""
echo -e "${BOLD}${BLUE}------------------------------------------------------------${NC}"
echo -e "${BOLD}Results${NC}"
echo -e "${BOLD}${BLUE}------------------------------------------------------------${NC}"
printf "  %-12s %s\n" "passed" "$PASS_COUNT"
printf "  %-12s %s\n" "failed" "$FAIL_COUNT"
printf "  %-12s %s\n" "skipped" "$SKIP_COUNT"
printf "  %-12s %s\n" "total" "$TOTAL_CHECKS"
echo ""

if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}Phase D demo completed.${NC}"
  echo ""
  info "Hero agent:      $AGENT_CONCIERGE"
  info "Email inbox:     $CONCIERGE_EMAIL"
  if [[ "$CARD_DEMO_RAN" == "true" ]]; then
    info "Card providerRef: $CARD_PROVIDER_REF"
    info "Card last4:       $CARD_LAST4"
  fi
  if [[ "$CARD_WEBHOOKS_RECORDED" == "true" ]]; then
    info "Card activity:    authorization $AUTHORIZATION_ID -> transaction $TRANSACTION_ID"
  fi
  if [[ "${#SKIP_NOTES[@]}" -gt 0 ]]; then
    echo ""
    info "Skipped items:"
    for note in "${SKIP_NOTES[@]}"; do
      info "  - $note"
    done
  fi
  echo ""
  exit 0
fi

echo -e "${RED}${BOLD}Demo finished with failing checks.${NC}"
echo ""
if [[ "${#SKIP_NOTES[@]}" -gt 0 ]]; then
  info "Skipped items:"
  for note in "${SKIP_NOTES[@]}"; do
    info "  - $note"
  done
  echo ""
fi
exit 1
