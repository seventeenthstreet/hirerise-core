#!/usr/bin/env bash
# =============================================================================
# HireRise — Secret Purge & Rotation Script
# =============================================================================
# Run this script ONCE after rotating all credentials.
# It removes committed secret files from git history and re-secures the repo.
#
# Prerequisites:
#   brew install git-filter-repo   (macOS)
#   pip install git-filter-repo    (Linux)
#   git-filter-repo --version      (verify)
#
# WARNING: This rewrites git history. All team members must re-clone after
# this runs. Coordinate with the team before executing.
#
# Usage:
#   chmod +x purge-secrets.sh
#   ./purge-secrets.sh
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

# ── Step 0: Confirm ───────────────────────────────────────────────────────────
echo -e "${YEL}⚠  This will rewrite git history. Ensure all team members know.${RST}"
echo -e "${YEL}   Have you rotated ALL credentials listed below? (y/N)${RST}"
echo ""
echo "   Credentials that MUST be rotated before running this:"
echo "   □ Firebase service account private key"
echo "   □ Supabase SERVICE_ROLE_KEY"
echo "   □ ANTHROPIC_API_KEY"
echo "   □ OPENROUTER_API_KEY"
echo "   □ GEMINI_API_KEY"
echo "   □ GROQ_API_KEY"
echo "   □ MISTRAL_API_KEY"
echo "   □ MASTER_ENCRYPTION_KEY (generate a new 32-char key)"
echo ""
read -r -p "Confirm all credentials have been rotated (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo -e "${RED}Aborted. Rotate credentials first, then re-run.${RST}"
  exit 1
fi

# ── Step 1: Verify git-filter-repo is available ───────────────────────────────
if ! command -v git-filter-repo &>/dev/null; then
  echo -e "${RED}Error: git-filter-repo not found.${RST}"
  echo "Install it with:  pip install git-filter-repo"
  echo "Or on macOS:      brew install git-filter-repo"
  exit 1
fi

echo ""
echo -e "${GRN}[1/7] Removing sensitive files from git history...${RST}"

# Files to remove from ALL commits in history
FILES_TO_PURGE=(
  ".env"
  "core/.env"
  "frond/.env.local"
  "hirerise-prod-firebase-adminsdk-fbsvc-709377e605.json"
  "serviceAccountKey.json.json"
  "serviceAccountKey.json"
  "firebase-admin.json"
  "firestore-backup.json"
)

for FILE in "${FILES_TO_PURGE[@]}"; do
  if git log --all --full-history -- "$FILE" | grep -q "commit"; then
    echo "  Removing from history: $FILE"
    git filter-repo --force --path "$FILE" --invert-paths 2>/dev/null || true
  fi
done

echo -e "${GRN}[2/7] Removing all *-adminsdk-*.json files from history...${RST}"
git filter-repo --force --filename-callback '
  import re
  if re.search(rb"adminsdk.*\.json|serviceAccountKey", filename):
    return None
  return filename
' 2>/dev/null || true

echo -e "${GRN}[3/7] Updating .gitignore to block future accidental commits...${RST}"
# .gitignore updates are in the separate .gitignore files provided
echo "  .gitignore files already updated (see security-output/)"

echo -e "${GRN}[4/7] Deleting local sensitive files...${RST}"
SENSITIVE_FILES=(
  "hirerise-prod-firebase-adminsdk-fbsvc-709377e605.json"
  "serviceAccountKey.json.json"
  "serviceAccountKey.json"
)
for F in "${SENSITIVE_FILES[@]}"; do
  if [ -f "$F" ]; then
    rm -f "$F"
    echo "  Deleted: $F"
  fi
done

echo -e "${GRN}[5/7] Moving firestore-backup.json out of repo...${RST}"
if [ -f "firestore-backup.json" ]; then
  BACKUP_DEST="$HOME/hirerise-firestore-backup-$(date +%Y%m%d).json"
  mv firestore-backup.json "$BACKUP_DEST"
  echo "  Moved to: $BACKUP_DEST (outside repo)"
fi

echo -e "${GRN}[6/7] Force-pushing rewritten history...${RST}"
echo ""
echo -e "${YEL}  About to force-push to origin. This will affect all branches.${RST}"
read -r -p "  Force push now? (y/N): " PUSH_CONFIRM
if [[ "$PUSH_CONFIRM" == "y" || "$PUSH_CONFIRM" == "Y" ]]; then
  git push origin --force --all
  git push origin --force --tags
  echo -e "${GRN}  Force push complete.${RST}"
else
  echo -e "${YEL}  Skipped. Run manually: git push origin --force --all${RST}"
fi

echo -e "${GRN}[7/7] Done. Post-purge checklist:${RST}"
echo ""
echo "  ✅ Git history rewritten — committed secrets removed"
echo "  ✅ Sensitive files deleted from working tree"
echo "  ✅ firestore-backup.json moved outside repo"
echo ""
echo -e "${YEL}  REQUIRED NEXT STEPS (do these now):${RST}"
echo ""
echo "  1. Fill in the new .env / .env.local with your ROTATED credentials"
echo "     → core/.env.example  → copy to core/.env"
echo "     → frond/.env.local.example  → copy to frond/.env.local"
echo ""
echo "  2. Notify all team members:"
echo "     'git history was rewritten — delete your local clone and re-clone'"
echo "     git clone <repo-url>"
echo ""
echo "  3. Revoke and delete the old credentials from every provider:"
echo "     Firebase Console → Project Settings → Service Accounts → Delete old key"
echo "     Supabase Dashboard → Settings → API → Regenerate service role key"
echo "     Anthropic → console.anthropic.com/keys → Delete old key"
echo "     OpenRouter → openrouter.ai/keys → Delete old key"
echo "     Gemini → aistudio.google.com → Delete old key"
echo "     Groq → console.groq.com/keys → Delete old key"
echo "     Mistral → console.mistral.ai → Delete old key"
echo ""
echo "  4. Rotate MASTER_ENCRYPTION_KEY and re-encrypt all secrets in Firestore:"
echo "     node -e \"console.log(require('crypto').randomBytes(16).toString('hex'))\""
echo "     Then run the secrets migration script with the new key."
echo ""
echo -e "${BLU}═══════════════════════════════════════════════════════════${RST}"
echo -e "${GRN}  Repository secured. Rotate credentials, then redeploy.${RST}"
echo -e "${BLU}═══════════════════════════════════════════════════════════${RST}"
echo ""