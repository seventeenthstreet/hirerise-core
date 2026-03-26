/**
 * src/hooks/useAuth.ts
 *
 * Thin re-export so any module that imports from '@/hooks/useAuth'
 * resolves to the canonical AuthProvider context.
 *
 * The education module (and any legacy code) can keep using:
 *   import { useAuth } from '@/hooks/useAuth';
 * without needing to know the internal path.
 */

export { useAuth } from '@/features/auth/components/AuthProvider';
