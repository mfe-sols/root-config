#!/usr/bin/env bash
#
# Idempotent Cloudflare setup for the vopenworld.com multi-tenant frontend.
#
# What it configures (matches DOMAIN_ROUTING.md):
#   1. SSL/TLS mode -> Full (strict)            (prevents Vercel redirect loops)
#   2. DNS  app.<domain>  CNAME cname.vercel-dns.com  (Proxied)
#   3. DNS  *.<domain>    CNAME cname.vercel-dns.com  (Proxied)
#   4. Origin Rule: rewrite upstream Host -> app.<domain> for business subdomains
#      so Vercel serves the shell instead of 404 (slug is detected client-side).
#
# It NEVER touches:
#   - api.<domain>        (backend origin; managed separately)
#   - the Vercel domain-verification record (*.vercel-dns-*.com)
#
# Safety: DRY-RUN by default. Nothing is changed unless you pass APPLY=1.
#
# Usage:
#   export CF_API_TOKEN=***            # Zone scope: DNS:Edit, Zone Settings:Edit, Zone:Edit(Rulesets)
#   export CF_ZONE_NAME=vopenworld.com # or: export CF_ZONE_ID=<id>
#   bash cloudflare-vopenworld-setup.sh            # dry-run preview
#   APPLY=1 bash cloudflare-vopenworld-setup.sh    # apply changes
#
set -euo pipefail

BASE_DOMAIN="${CF_ZONE_NAME:-vopenworld.com}"
APP_HOST="app.${BASE_DOMAIN}"
API_HOST="api.${BASE_DOMAIN}"
WWW_HOST="www.${BASE_DOMAIN}"
VERCEL_CNAME="cname.vercel-dns.com"
RULESET_PHASE="http_request_origin"
RULE_DESC="vopenworld business subdomain -> app host override"
APPLY="${APPLY:-0}"
API="https://api.cloudflare.com/client/v4"

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: CF_API_TOKEN is not set." >&2
  exit 1
fi

cf() {
  # cf <METHOD> <PATH> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${API}${path}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -fsS -X "$method" "${API}${path}" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json"
  fi
}

jqr() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s||"null");const f=new Function("j","env","return ("+process.argv[1]+")");const v=f(j,process.env);process.stdout.write(v===undefined||v===null?"":String(v));}catch(e){process.stdout.write("");}})' "$1"; }

step() { printf "\n=== %s ===\n" "$1"; }
note() { printf "  %s\n" "$1"; }
would() { if [[ "$APPLY" == "1" ]]; then printf "  APPLY: %s\n" "$1"; else printf "  DRY-RUN (would): %s\n" "$1"; fi; }

# --- Resolve zone id ---------------------------------------------------------
ZONE_ID="${CF_ZONE_ID:-}"
if [[ -z "$ZONE_ID" ]]; then
  step "Resolve zone id for ${BASE_DOMAIN}"
  resp="$(cf GET "/zones?name=${BASE_DOMAIN}&status=active")"
  ZONE_ID="$(printf '%s' "$resp" | jqr 'j.result && j.result[0] && j.result[0].id')"
  if [[ -z "$ZONE_ID" ]]; then echo "ERROR: zone ${BASE_DOMAIN} not found / token lacks access." >&2; exit 1; fi
  note "zone_id=${ZONE_ID}"
fi

# --- 1. SSL mode -> strict (Full strict) ------------------------------------
step "SSL/TLS mode"
cur_ssl="$(cf GET "/zones/${ZONE_ID}/settings/ssl" | jqr 'j.result && j.result.value')"
note "current=${cur_ssl}"
if [[ "$cur_ssl" == "strict" ]]; then
  note "already Full (strict) — ok"
else
  would "set SSL mode -> strict"
  [[ "$APPLY" == "1" ]] && cf PATCH "/zones/${ZONE_ID}/settings/ssl" '{"value":"strict"}' >/dev/null && note "done"
fi

# --- 2/3. Upsert proxied CNAME records --------------------------------------
upsert_cname() {
  local name="$1" content="$2"
  step "DNS ${name} CNAME ${content} (Proxied)"
  local list rec_id rec_content rec_proxied rec_type
  list="$(cf GET "/zones/${ZONE_ID}/dns_records?name=${name}")"
  rec_id="$(printf '%s' "$list" | jqr 'j.result && j.result[0] && j.result[0].id')"
  rec_type="$(printf '%s' "$list" | jqr 'j.result && j.result[0] && j.result[0].type')"
  rec_content="$(printf '%s' "$list" | jqr 'j.result && j.result[0] && j.result[0].content')"
  rec_proxied="$(printf '%s' "$list" | jqr 'j.result && j.result[0] && j.result[0].proxied')"
  local payload
  payload="$(printf '{"type":"CNAME","name":"%s","content":"%s","proxied":true,"ttl":1}' "$name" "$content")"
  if [[ -z "$rec_id" ]]; then
    would "CREATE ${name} -> ${content} proxied=true"
    [[ "$APPLY" == "1" ]] && cf POST "/zones/${ZONE_ID}/dns_records" "$payload" >/dev/null && note "created"
  elif [[ "$rec_type" == "CNAME" && "$rec_content" == "$content" && "$rec_proxied" == "true" ]]; then
    note "already correct (CNAME ${content}, proxied) — ok"
  else
    note "current: type=${rec_type} content=${rec_content} proxied=${rec_proxied}"
    would "UPDATE ${name} -> CNAME ${content} proxied=true"
    [[ "$APPLY" == "1" ]] && cf PATCH "/zones/${ZONE_ID}/dns_records/${rec_id}" "$payload" >/dev/null && note "updated"
  fi
}
upsert_cname "$APP_HOST" "$VERCEL_CNAME"
upsert_cname "*.${BASE_DOMAIN}" "$VERCEL_CNAME"

# --- Safety check: api host must NOT point at Vercel ------------------------
step "Verify ${API_HOST} is not pointing at Vercel"
api_content="$(cf GET "/zones/${ZONE_ID}/dns_records?name=${API_HOST}" | jqr 'j.result && j.result[0] && j.result[0].content')"
if [[ -z "$api_content" ]]; then
  note "WARNING: no ${API_HOST} record found — wildcard would swallow API traffic. Add an explicit api record to the backend origin."
elif [[ "$api_content" == *"vercel"* ]]; then
  note "WARNING: ${API_HOST} -> ${api_content} (looks like Vercel!). API must point to the backend origin."
else
  note "ok (${API_HOST} -> ${api_content})"
fi

# --- 4. Origin Rule: host + SNI override for business subdomains -------------
step "Origin Rule (Host header + SNI override -> ${APP_HOST})"
# Expression: any *.vopenworld.com host except app/api/www.
EXPR="(ends_with(http.host, \".${BASE_DOMAIN}\") and http.host ne \"${APP_HOST}\" and http.host ne \"${API_HOST}\" and http.host ne \"${WWW_HOST}\")"
# Override BOTH Host header AND SNI so the Cloudflare->Vercel TLS handshake uses
# a hostname Vercel has a certificate for (app). Without the SNI override the
# proxied wildcard returns HTTP 525 (SSL handshake failed) because Vercel has no
# cert for the business subdomain.
RULE_JSON="$(printf '{"action":"route","action_parameters":{"host_header":"%s","sni":{"value":"%s"}},"expression":"%s","description":"%s","enabled":true}' "$APP_HOST" "$APP_HOST" "$EXPR" "$RULE_DESC")"

# Find existing ruleset for the origin phase (entrypoint).
existing="$(cf GET "/zones/${ZONE_ID}/rulesets/phases/${RULESET_PHASE}/entrypoint" 2>/dev/null || true)"
ruleset_id="$(printf '%s' "$existing" | jqr 'j&&j.result&&j.result.id')"
rule_id="$(printf '%s' "$existing" | RULE_DESC="$RULE_DESC" jqr 'j&&j.result&&j.result.rules&&(j.result.rules.find(r=>r.description===env.RULE_DESC)||{}).id')"

if [[ -z "$ruleset_id" ]]; then
  would "CREATE origin ruleset + host-override rule"
  CREATE_JSON="$(printf '{"name":"vopenworld origin rules","kind":"zone","phase":"%s","rules":[%s]}' "$RULESET_PHASE" "$RULE_JSON")"
  [[ "$APPLY" == "1" ]] && cf PUT "/zones/${ZONE_ID}/rulesets/phases/${RULESET_PHASE}/entrypoint" "$CREATE_JSON" >/dev/null && note "created"
elif [[ -n "$rule_id" ]]; then
  note "rule already exists (id=${rule_id})"
  would "UPDATE existing host-override rule"
  [[ "$APPLY" == "1" ]] && cf PATCH "/zones/${ZONE_ID}/rulesets/${ruleset_id}/rules/${rule_id}" "$RULE_JSON" >/dev/null && note "updated"
else
  would "APPEND host-override rule to ruleset ${ruleset_id}"
  [[ "$APPLY" == "1" ]] && cf POST "/zones/${ZONE_ID}/rulesets/${ruleset_id}/rules" "$RULE_JSON" >/dev/null && note "appended"
fi

step "Done"
if [[ "$APPLY" != "1" ]]; then
  note "This was a DRY-RUN. Re-run with APPLY=1 to apply."
else
  note "Applied. Remember to REMOVE *.${BASE_DOMAIN} from the Vercel project (it never validates with external DNS)."
fi
