#!/usr/bin/env bash
# =============================================================================
# HireRise — Secret Purge & Rotation Script (Firebase-Free)
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

# ── Step 0: Confirm ─────────────────────────────────────────
echo -e "${YEL}⚠  This will rewrite git history. Ensure all team members know.${RST}"
echo -e "${YEL}   Have you rotated ALL credentials listed below? (y/N)${RST}"
echo ""
echo "   Credentials that MUST be rotated before running this:"
echo "   □ Supabase SERVICE_ROLE_KEY"
echo "   □ SUPABASE_URL"
echo "   □ ANTHROPIC_API_KEY"
echo "   □ OPENROUTER_API_KEY"
echo "   □ GEMINI_API_KEY"
echo "   □ GROQ_API_KEY"
echo "   □ MISTRAL_API_KEY"
echo "   □ MASTER_ENCRYPTION_KEY (generate new 32-char key)"
echo ""

read -r -p "Confirm all credentials have been rotated (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo -e "${RED}Aborted. Rotate credentials first.${RST}"
  exit 1
fi

# ── Step 1: Verify git-filter-repo ─────────────────────────
if ! command -v git-filter-repo &>/dev/null; then
  echo -e "${RED}Error: git-filter-repo not found.${RST}"
  exit 1
fi

echo ""
echo -e "${GRN}[1/6] Removing sensitive files from git history...${RST}"

FILES_TO_PURGE=(
  ".env"
  "core/.env"
  "frond/.env.local"
)

for FILE in "${FILES_TO_PURGE[@]}"; do
  if git log --all --full-history -- "$FILE" | grep -q "commit"; then
    echo "  Removing from history: $FILE"
    git filter-repo --force --path "$FILE" --invert-paths 2>/dev/null || true
  fi
done

echo -e "${GRN}[2/6] Removing secret JSON & key files...${RST}"
git filter-repo --force --filename-callback '
  import re
  if re.search(rb"\.json$|\.key$|\.pem$", filename):
    return None
  return filename
' 2>/dev/null || true

echo -e "${GRN}[3/6] Deleting local sensitive files...${RST}"
rm -f *.json *.key *.pem 2>/dev/null || true

echo -e "${GRN}[4/6] Force-pushing rewritten history...${RST}"
echo ""
read -r -p "Force push now? (y/N): " PUSH_CONFIRM

if [[ "$PUSH_CONFIRM" == "y" || "$PUSH_CONFIRM" == "Y" ]]; then
  git push origin --force --all
  git push origin --force --tags
  echo -e "${GRN}Force push complete.${RST}"
else
  echo -e "${YEL}Skipped push.${RST}"
fi

echo -e "${GRN}[5/6] Post-purge checklist:${RST}"
echo ""
echo "  1. Recreate .env files with NEW credentials"
echo "  2. Revoke old API keys from all providers"
echo "  3. Re-clone repo for all team members"

echo -e "${GRN}[6/6] Done — repository secured.${RST}"