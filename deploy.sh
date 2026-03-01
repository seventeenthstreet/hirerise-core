#!/usr/bin/env bash
# HireRise — GCP Infrastructure Setup & Deployment Script
# Usage: ./deploy.sh [PROJECT_ID] [REGION]

set -euo pipefail

PROJECT_ID="${1:?Usage: deploy.sh PROJECT_ID REGION}"
REGION="${2:-us-central1}"
REPO="gcr.io/${PROJECT_ID}"

echo "=== HireRise Deployment: ${PROJECT_ID} / ${REGION} ==="

# ─── Enable APIs ─────────────────────────────────────────────────────────────
gcloud services enable \
  run.googleapis.com \
  pubsub.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudlogging.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  --project="${PROJECT_ID}"

# ─── Service Accounts ─────────────────────────────────────────────────────────
create_sa() {
  local name="$1" display="$2"
  gcloud iam service-accounts create "${name}" \
    --display-name="${display}" \
    --project="${PROJECT_ID}" 2>/dev/null || echo "SA ${name} already exists"
}

create_sa "hirerise-api"              "HireRise API Service"
create_sa "hirerise-resume-worker"    "HireRise Resume Worker"
create_sa "hirerise-salary-worker"    "HireRise Salary Worker"
create_sa "hirerise-career-worker"    "HireRise Career Worker"
create_sa "hirerise-notification"     "HireRise Notification Worker"

# ─── IAM Bindings ─────────────────────────────────────────────────────────────
bind_role() {
  local sa="$1" role="$2"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="${role}" --condition=None
}

# API Service: publish only
bind_role "hirerise-api" "roles/pubsub.publisher"
bind_role "hirerise-api" "roles/datastore.user"
bind_role "hirerise-api" "roles/logging.logWriter"

# Workers: subscribe + Firestore + publish downstream
for worker in resume-worker salary-worker career-worker notification; do
  bind_role "hirerise-${worker}" "roles/pubsub.subscriber"
  bind_role "hirerise-${worker}" "roles/pubsub.publisher"
  bind_role "hirerise-${worker}" "roles/datastore.user"
  bind_role "hirerise-${worker}" "roles/logging.logWriter"
done

# Resume worker also needs Storage read
bind_role "hirerise-resume-worker" "roles/storage.objectViewer"

# ─── Pub/Sub Topics & Subscriptions ──────────────────────────────────────────
create_topic() {
  local topic="$1"
  gcloud pubsub topics create "${topic}" --project="${PROJECT_ID}" 2>/dev/null || echo "Topic ${topic} exists"
}

create_sub() {
  local sub="$1" topic="$2" sa="$3" dlq="$4"
  gcloud pubsub subscriptions create "${sub}" \
    --topic="${topic}" \
    --project="${PROJECT_ID}" \
    --ack-deadline=60 \
    --min-retry-delay=10s \
    --max-retry-delay=600s \
    --max-delivery-attempts=5 \
    --dead-letter-topic="${dlq}" \
    --dead-letter-topic-project="${PROJECT_ID}" \
    --service-account="${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    2>/dev/null || echo "Sub ${sub} exists"
}

# Topics
create_topic "hirerise.resume.submitted.v1"
create_topic "hirerise.salary.benchmark_requested.v1"
create_topic "hirerise.career.path_requested.v1"
create_topic "hirerise.score.updated.v1"
create_topic "hirerise.notification.requested.v1"
create_topic "hirerise.dlq.resume.v1"
create_topic "hirerise.dlq.salary.v1"
create_topic "hirerise.dlq.career.v1"
create_topic "hirerise.dlq.notification.v1"

# Subscriptions with DLQ
create_sub "hirerise.resume.submitted.sub" \
  "hirerise.resume.submitted.v1" "hirerise-resume-worker" "hirerise.dlq.resume.v1"

create_sub "hirerise.salary.benchmark_requested.sub" \
  "hirerise.salary.benchmark_requested.v1" "hirerise-salary-worker" "hirerise.dlq.salary.v1"

create_sub "hirerise.career.path_requested.sub" \
  "hirerise.career.path_requested.v1" "hirerise-career-worker" "hirerise.dlq.career.v1"

create_sub "hirerise.notification.requested.sub" \
  "hirerise.notification.requested.v1" "hirerise-notification" "hirerise.dlq.notification.v1"

# ─── Build & Push Images ──────────────────────────────────────────────────────
build_push() {
  local service="$1"
  echo "Building ${service}..."
  gcloud builds submit "./${service}" \
    --tag="${REPO}/hirerise-${service}:$(git rev-parse --short HEAD)" \
    --project="${PROJECT_ID}"
}

build_push "api-service"
build_push "resume-worker"
build_push "salary-worker"
build_push "career-worker"
build_push "notification-worker"

# ─── Deploy Cloud Run Services ────────────────────────────────────────────────
COMMIT=$(git rev-parse --short HEAD)

# API Service (HTTP, autoscaling)
gcloud run deploy hirerise-api \
  --image="${REPO}/hirerise-api-service:${COMMIT}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="hirerise-api@${PROJECT_ID}.iam.gserviceaccount.com" \
  --min-instances=1 \
  --max-instances=100 \
  --concurrency=250 \
  --memory=1Gi \
  --cpu=2 \
  --timeout=30s \
  --no-allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},NODE_ENV=production,SERVICE_NAME=api-service,LOG_LEVEL=info,PUBSUB_RESUME_TOPIC=hirerise.resume.submitted.v1,PUBSUB_SALARY_TOPIC=hirerise.salary.benchmark_requested.v1,PUBSUB_CAREER_TOPIC=hirerise.career.path_requested.v1,PUBSUB_NOTIFICATION_TOPIC=hirerise.notification.requested.v1,PUBSUB_SCORE_UPDATED_TOPIC=hirerise.score.updated.v1" \
  --project="${PROJECT_ID}"

# Deploy workers (long-running, 1 CPU, streaming)
deploy_worker() {
  local name="$1" image="$2" sa="$3" envvars="$4"
  gcloud run deploy "${name}" \
    --image="${REPO}/${image}:${COMMIT}" \
    --region="${REGION}" \
    --platform=managed \
    --service-account="${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --min-instances=1 \
    --max-instances=20 \
    --concurrency=1 \
    --memory=2Gi \
    --cpu=2 \
    --timeout=900s \
    --no-allow-unauthenticated \
    --set-env-vars="${envvars}" \
    --project="${PROJECT_ID}"
}

COMMON_WORKER_VARS="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},NODE_ENV=production,LOG_LEVEL=info,PUBSUB_NOTIFICATION_TOPIC=hirerise.notification.requested.v1,PUBSUB_SCORE_UPDATED_TOPIC=hirerise.score.updated.v1"

deploy_worker "hirerise-resume-worker" "hirerise-resume-worker" "hirerise-resume-worker" \
  "${COMMON_WORKER_VARS},SERVICE_NAME=resume-worker,PUBSUB_RESUME_SUBSCRIPTION=hirerise.resume.submitted.sub,RESUME_ENGINE_VERSION=resume_score_v1.0,RESUME_STORAGE_BUCKET=hirerise-resumes-${PROJECT_ID}"

deploy_worker "hirerise-salary-worker" "hirerise-salary-worker" "hirerise-salary-worker" \
  "${COMMON_WORKER_VARS},SERVICE_NAME=salary-worker,PUBSUB_SALARY_SUBSCRIPTION=hirerise.salary.benchmark_requested.sub,SALARY_ENGINE_VERSION=salary_bench_v1.0"

deploy_worker "hirerise-career-worker" "hirerise-career-worker" "hirerise-career-worker" \
  "${COMMON_WORKER_VARS},SERVICE_NAME=career-worker,PUBSUB_CAREER_SUBSCRIPTION=hirerise.career.path_requested.sub,CAREER_ENGINE_VERSION=career_path_v1.0"

deploy_worker "hirerise-notification-worker" "hirerise-notification-worker" "hirerise-notification" \
  "${COMMON_WORKER_VARS},SERVICE_NAME=notification-worker,PUBSUB_NOTIFICATION_SUBSCRIPTION=hirerise.notification.requested.sub"

echo "=== Deployment complete ==="