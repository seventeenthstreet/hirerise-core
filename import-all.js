function mapFields(doc) {
  return {
    id: doc.id || null,
    action: doc.action || null,
    user_id: doc.userId || null,
    target_id: doc.targetId || null,
    admin_id: doc.adminId || null,
    ai_credits_remaining: doc.aiCreditsRemaining || null,
    consent_granted_at: doc.consentGrantedAt || null,
    analysis_status: doc.analysisStatus || null,
    category: doc.category || null,
    aliases: doc.aliases || null,
    metadata: doc.metadata || doc || null
  };
}