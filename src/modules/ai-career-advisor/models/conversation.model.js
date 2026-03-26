'use strict';

/**
 * models/conversation.model.js
 *
 * Firestore collection name and document builder for AI Career Advisor
 * conversation history.
 *
 * Collection: edu_career_conversations
 *   — prefixed edu_ to stay isolated from the career platform collections.
 *
 * Document shape:
 *   id           — auto-generated Firestore doc ID
 *   student_id   — user ID (indexed for query)
 *   user_message — string — the student's question
 *   ai_response  — string — Claude's personalised answer
 *   created_at   — serverTimestamp
 */

// ─── Collection name ───────────────────────────────────────────────────────────

const CONVERSATIONS_COLLECTION = 'edu_career_conversations';

// ─── Document builder ──────────────────────────────────────────────────────────

/**
 * buildConversationDoc(studentId, userMessage, aiResponse)
 *
 * Returns a plain object ready to be written to Firestore.
 * created_at is always null here — the repository sets it via FieldValue.serverTimestamp().
 */
function buildConversationDoc(studentId, userMessage, aiResponse) {
  return {
    student_id:   studentId,
    user_message: userMessage,
    ai_response:  aiResponse,
    created_at:   null, // set by repository
  };
}

module.exports = {
  CONVERSATIONS_COLLECTION,
  buildConversationDoc,
};









