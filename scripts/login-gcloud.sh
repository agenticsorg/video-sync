#!/usr/bin/env bash
#
# Log in to gcloud — but only when the existing credential has actually
# expired.
#
# This script used to be one unconditional `gcloud auth login`, so every
# run opened a browser OAuth flow whether or not the credential was
# fine. The org enforces reauthentication roughly daily, which means the
# answer is genuinely "sometimes" — worth asking rather than assuming.
#
# Usage:
#   bash scripts/login-gcloud.sh            # log in only if needed
#   bash scripts/login-gcloud.sh --check    # report only, never log in
#   bash scripts/login-gcloud.sh --force    # log in regardless
#   ACCOUNT=someone@agentics.org bash scripts/login-gcloud.sh
#
# Exit codes:
#   0  a usable credential is present (already, or after logging in)
#   1  no usable credential (--check found none, or the login failed)
#
# Note: `gcloud auth login` is interactive — it prints a URL and waits
# for a verification code. It cannot run unattended, so this script is
# for a human at a terminal. --check is the part that IS safe to call
# from other scripts; deploy.sh could use it to fail fast with a clear
# message instead of dying part-way through a build.

set -uo pipefail

ACCOUNT="${ACCOUNT:-martin.cleaver@agentics.org}"
PROJECT="${PROJECT:-agentics-487016}"
MODE="login"

case "${1:-}" in
  --check) MODE="check" ;;
  --force) MODE="force" ;;
  "")      ;;
  *) echo "Unknown option: $1" >&2; echo "Usage: $0 [--check|--force]" >&2; exit 2 ;;
esac

ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

# Minting an access token is the only check that actually proves the
# credential works — `gcloud auth list` happily shows an account whose
# refresh token expired hours ago.
#
# The environment matters as much as the command:
#   CLOUDSDK_CORE_DISABLE_PROMPTS  stops gcloud starting an interactive
#                                  reauth *inside the check*, which would
#                                  turn a yes/no question into a login
#   </dev/null                     belt and braces for the same thing
#   timeout                        a wedged auth plugin must not hang a
#                                  script whose whole job is to be quick
credential_is_live() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 timeout 30 \
    gcloud auth print-access-token --account="$ACCOUNT" \
    >/dev/null 2>"$ERR_FILE" </dev/null
}

# Why the check failed, in the operator's terms rather than gcloud's.
diagnose() {
  if grep -qi "does not have any valid credentials\|not have credentials\|no credentialed accounts" "$ERR_FILE"; then
    echo "never logged in on this machine"
  elif grep -qi "reauthentication failed\|reauth" "$ERR_FILE"; then
    echo "session expired (this org reauthenticates about daily)"
  elif grep -qi "timed out\|timeout" "$ERR_FILE"; then
    echo "the check timed out — gcloud may be wedged"
  else
    head -1 "$ERR_FILE" | sed 's/^ERROR: *//'
  fi
}

echo "==> Checking gcloud credential for ${ACCOUNT}"

if [[ "$MODE" != "force" ]] && credential_is_live; then
  echo "    Credential is live — no login needed."
  # Report the surrounding state rather than changing it. deploy.sh's
  # `gcloud run deploy` needs core/project set, and an unset project is
  # a confusing mid-deploy failure if nobody mentions it up front.
  CURRENT_PROJECT="$(gcloud config get-value project 2>/dev/null)"
  if [[ -z "$CURRENT_PROJECT" || "$CURRENT_PROJECT" == "(unset)" ]]; then
    echo "    WARNING: no project set. deploy.sh will need it:"
    echo "             gcloud config set project ${PROJECT}"
  elif [[ "$CURRENT_PROJECT" != "$PROJECT" ]]; then
    echo "    NOTE: project is ${CURRENT_PROJECT}, not ${PROJECT}."
  else
    echo "    Project: ${CURRENT_PROJECT}"
  fi
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  echo "    NOT usable — $(diagnose)"
  echo "    Run: bash scripts/login-gcloud.sh"
  exit 1
fi

if [[ "$MODE" == "force" ]]; then
  echo "    --force given; logging in regardless."
else
  echo "    NOT usable — $(diagnose)"
fi

echo "==> Starting interactive login"
echo "    A URL will be printed; open it, then paste the verification code back here."
echo "    This needs a real terminal — it cannot run unattended."
gcloud auth login --account="$ACCOUNT"

# Trust nothing: confirm the login actually produced a working credential
# rather than assuming a zero exit from `gcloud auth login` means success.
if credential_is_live; then
  echo "==> Credential is live."
  exit 0
fi
echo "==> Login finished but the credential still isn't usable — $(diagnose)" >&2
exit 1
