CREATE TABLE IF NOT EXISTS edu_career_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT NOT NULL,
  user_message TEXT,
  ai_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edu_career_conversations_student_created
  ON edu_career_conversations (student_id ASC, created_at ASC);

ALTER TABLE edu_career_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_owner"
ON edu_career_conversations
FOR ALL
USING (student_id = auth.uid()::text);