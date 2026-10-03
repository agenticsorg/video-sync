#!/usr/bin/env bash
#
# ADR-081 Phase 4 — run the Kaltura portal sweep on a schedule.
#
# Kaltura ingests from Zoom automatically on notification, so new
# uncategorised recordings appear every Thursday and Friday without
# anyone doing anything. A one-off sweep returns the portal to
# invisibility within a week; this keeps it current.
#
#   bash scripts/kaltura-sweep-schedule.sh            # create (plan-only)
#   bash scripts/kaltura-sweep-schedule.sh --apply    # create (writes)
#   bash scripts/kaltura-sweep-schedule.sh --delete
#   bash scripts/kaltura-sweep-schedule.sh --run-now
#
# ── Plan-only is the default, deliberately ───────────────────────────
# ADR-081 §4 says nothing is written until an operator reads the plan,
# because a mis-match makes a PRIVATE meeting visible on the public
# portal — internal Committee and Management meetings share this Zoom
# and Kaltura account, ten minutes either side of the public shows.
#
# A plan-only job still delivers Phase 4's value: the summary lands in
# Cloud Logging within hours of a recording appearing, so you learn
# there is uncategorised content without anything being written. Query
# it with:
#
#   gcloud logging read \
#     'jsonPayload.component="ext:kaltura-sweep"' --freshness=7d
#
# Switch to --apply only once a few plans have been reviewed and were
# right every time. The allowlist makes that defensible — the sweep
# can only ever touch series an operator explicitly gave
# scheduled_days — but "defensible" is not "verified".
set -euo pipefail

PROJECT="${PROJECT:-agentics-487016}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-video-sync}"
JOB="${JOB:-kaltura-portal-sweep}"
# Thursday and Friday shows finish by 13:30 ET; 16:00 ET gives the
# connector (which ingests "within an hour or so") time to land the
# entry before the sweep looks for it.
SCHEDULE="${SCHEDULE:-0 16 * * 4,5}"
TZ_NAME="${TZ_NAME:-America/New_York}"
# Kaltura's createdAt is the INGEST time, and the sweep filters on it.
# A 14-day window comfortably covers a missed run or two without
# re-scanning the whole account every time.
LOOKBACK_DAYS="${LOOKBACK_DAYS:-14}"
SA_NAME="${SA_NAME:-kaltura-sweep-scheduler}"
IAP_AUDIENCE="${IAP_AUDIENCE:-/projects/667037737667/locations/${REGION}/services/${SERVICE}}"

APPLY=false
ACTION=create
for arg in "$@"; do
  case "$arg" in
    --apply)   APPLY=true ;;
    --delete)  ACTION=delete ;;
    --run-now) ACTION=run ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
        --format='value(status.url)')"
[ -n "$URL" ] || { echo "could not resolve the Cloud Run URL" >&2; exit 1; }

case "$ACTION" in
  delete)
    gcloud scheduler jobs delete "$JOB" --location "$REGION" --project "$PROJECT" --quiet
    echo "deleted $JOB (the service account is left in place)"
    exit 0 ;;
  run)
    gcloud scheduler jobs run "$JOB" --location "$REGION" --project "$PROJECT"
    echo "triggered $JOB — read the outcome with:"
    echo "  gcloud logging read 'jsonPayload.component=\"ext:kaltura-sweep\"' --freshness=10m --project $PROJECT"
    exit 0 ;;
esac

echo "==> service account"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name "Kaltura portal sweep (ADR-081 Phase 4)"

# The service sits behind IAP, so the caller needs to be an IAP-secured
# web-app user AND able to invoke the Run service. Both are required:
# run.invoker alone gets a 403 from IAP, and the IAP role alone gets a
# 403 from Run.
echo "==> granting invoker + IAP access to $SA_EMAIL"
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/run.invoker --quiet >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/iap.httpsResourceAccessor --quiet >/dev/null

BODY="$(printf '{"apply":%s,"from":"__FROM__"}' "$APPLY")"
echo "==> scheduling $JOB  ($SCHEDULE $TZ_NAME)  apply=$APPLY"
echo "    NOTE: 'from' is baked at creation time. Re-run this script"
echo "    periodically, or switch the route to a lookback window, if"
echo "    you want the range to keep moving. Today it is a fixed date"
echo "    ${LOOKBACK_DAYS} days back, which is honest about what it does."
FROM="$(date -u -d "-${LOOKBACK_DAYS} days" +%Y-%m-%d 2>/dev/null \
        || python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=${LOOKBACK_DAYS})).isoformat())")"
BODY="${BODY/__FROM__/$FROM}"

ARGS=(
  --location "$REGION" --project "$PROJECT"
  --schedule "$SCHEDULE" --time-zone "$TZ_NAME"
  --uri "${URL}/api/kaltura/sweep" --http-method POST
  --headers "Content-Type=application/json"
  --message-body "$BODY"
  --oidc-service-account-email "$SA_EMAIL"
  --oidc-token-audience "$IAP_AUDIENCE"
  --attempt-deadline 600s
)
if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${ARGS[@]}" --quiet
else
  gcloud scheduler jobs create http "$JOB" "${ARGS[@]}" --quiet
fi

echo
echo "done. body: $BODY"
$APPLY && echo "    THIS JOB WRITES to Kaltura." \
       || echo "    Plan-only; writes nothing. Re-run with --apply to change that."
echo "    verify now:  bash scripts/kaltura-sweep-schedule.sh --run-now"
