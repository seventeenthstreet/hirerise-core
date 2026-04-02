'use strict';

/**
 * models/conversation.model.js
 *
 * Supabase table name and row builder for AI Career Advisor
 * conversation history.
 *
 * Table: edu_career_conversations
 *   — prefixed edu_ to stay isolated from platform-wide chat tables.
 *
 * Row shape:
 *   student_id   — UUID / user ID (indexed)
 *   user_message — student question
 *   ai_response  — Claude response
 *   created_at   — timestamptz (set during insert)
 */

// ─────────────────────────────────────────────────────────────
const CONVERSATIONS_COLLECTION = 'edu_career_conversations';

// ─────────────────────────────────────────────────────────────
function buildConversationDoc(studentId, userMessage, aiResponse) {
  return {
    student_id: studentId,
    user_message: userMessage,
    ai_response: aiResponse,
  };
}

module.exports = {
  CONVERSATIONS_COLLECTION,
  buildConversationDoc,
};