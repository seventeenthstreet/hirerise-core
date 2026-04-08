#!/usr/bin/env bash
# =============================================================================
# HireRise — Secret Purge & Repository Security Hardening (Production Safe)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
YEL='\033[1;33m'
GRN='\033[0;32m'
BLU='\033[0;34m'
RST='\033[0m'

echo ""
echo -e "${BLU}═══════════════════════════════════════════════════════════${RST}"
echo -e "${BLU}  HireRise Secret Purge & Repository Security Hardening${RST}"
echo -e "${BLU}═══════════════════════════════════════════════════════════${RST}"
echo ""

echo -e "${YEL}⚠ This will rewrite git history. Ensure all team members know.${RST}"
echo -e "${YEL}⚠ Rotate ALL secrets BEFORE running this.${RST}"
echo ""

echo "Credentials that MUST already be rotated:"
echo "  □ Supabase SERVICE_ROLE_KEY"
echo "  □ SUPABASE_URL"
echo "  □ ANTHROPIC_API_KEY"
echo "  □ OPENROUTER_API_KEY"
echo "  □ GEMINI_API_KEY"
echo "  □ GROQ_API_KEY"
echo "  □ MISTRAL_API_KEY"
echo "  □ MASTER_ENCRYPTION_KEY"
echo ""

read -r -p "Confirm all credentials are rotated (y/N): " CONFIRM
if [[ "${CONFIRM:-N}" != "y" && "${CONFIRM:-N}" != "Y" ]]; then
  echo -e "${RED}Aborted. Rotate credentials first.${RST}"
  exit 1
fi

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo -e "${RED}Error: git-filter-repo not found.${RST}"
  echo "Install: pip install git-filter-repo"
  exit 1
fi

echo ""
echo -e "${GRN}[1/5] Rewriting git history in ONE safe pass...${RST}"

git filter-repo --force \
  --path .env --invert-paths \
  --path core/.env --invert-paths \
  --path frontend/.env.local --invert-paths \
  --path-glob '**/.env' --invert-paths \
  --path-glob '**/.env.*' --invert-paths \
  --filename-callback '
import re
if re.search(
    rb"\.(json|key|pem|p8|crt)$",
    filename,
):
    return None
return filename
'

echo -e "${GRN}[2/5] Removing local sensitive files...${RST}"
find . -type f \
  \( -name "*.json" -o -name "*.key" -o -name "*.pem" -o -name "*.p8" -o -name "*.crt" \) \
  -delete

echo -e "${GRN}[3/5] Force-push rewritten history...${RST}"
read -r -p "Force push now? (y/N): " PUSH_CONFIRM

if [[ "${PUSH_CONFIRM:-N}" == "y" || "${PUSH_CONFIRM:-N}" == "Y" ]]; then
  git push origin --force --all
  git push origin --force --tags
  echo -e "${GRN}Force push complete.${RST}"
else
  echo -e "${YEL}Skipped push.${RST}"
fi

echo -e "${GRN}[4/5] Post-purge checklist${RST}"
echo "  1. Recreate .env files with NEW credentials"
echo "  2. Revoke ALL old provider keys"
echo "  3. Re-clone repo for all team members"
echo "  4. Invalidate CI/CD cached secrets"
echo "  5. Rotate Supabase JWT secrets if exposed"

echo -e "${GRN}[5/5] Done — repository secured.${RST}"