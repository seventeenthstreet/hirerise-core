'use strict';

/**
 * @file src/hooks/useFileUpload.js
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * useFileUpload — shared upload state hook
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Encapsulates all upload UX state and validation logic for BOTH upload flows:
 *   • Sync:  POST /onboarding/upload-cv  (uploadCvDuringOnboarding)
 *   • Async: POST /resumes               (uploadResume)
 *
 * By sharing this hook, both flows get identical:
 *   ✅ Validation (via validateFile)
 *   ✅ Loading/disabled state management
 *   ✅ Error display + clearing
 *   ✅ Backend error mapping
 *
 * USAGE
 * ─────
 *   import { useFileUpload } from '@/hooks/useFileUpload';
 *
 *   const {
 *     file, error, isLoading, isSubmitDisabled,
 *     handleFileChange, handleUpload, reset,
 *   } = useFileUpload({ onSuccess });
 *
 * The hook owns state only. Pass a `uploadFn` async function that calls
 * your specific API endpoint. See examples at the bottom.
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/router'; // adjust to your router
import {
  validateFile,
  mapBackendError,
} from '@/lib/validation/fileValidation';

/**
 * @typedef {Object} UseFileUploadOptions
 * @property {(result: any) => void} [onSuccess]  — called with API response on success
 * @property {(err: any)   => void} [onError]     — called with error object on failure
 */

/**
 * @typedef {Object} UseFileUploadReturn
 * @property {File|null}  file              — currently selected file
 * @property {string|null} error            — inline error message (null = no error)
 * @property {boolean}    isLoading         — true while API call is in flight
 * @property {boolean}    isSubmitDisabled  — true when submit must be blocked
 * @property {(e: React.ChangeEvent<HTMLInputElement>) => void} handleFileChange
 * @property {(uploadFn: (file: File) => Promise<any>) => Promise<void>} handleUpload
 * @property {() => void} reset             — clears all state
 */

/**
 * @param {UseFileUploadOptions} [options]
 * @returns {UseFileUploadReturn}
 */
export function useFileUpload({ onSuccess, onError } = {}) {
  const router = useRouter();

  const [file, setFile]                     = useState(null);
  const [error, setError]                   = useState(null);
  const [isLoading, setIsLoading]           = useState(false);
  const [isSubmitDisabled, setSubmitDisabled] = useState(true);

  /**
   * handleFileChange
   *
   * Called on <input type="file" onChange={handleFileChange}>.
   * Runs client-side validation immediately on file selection.
   *   • Valid file   → clears any prior error, enables submit
   *   • Invalid file → shows error, keeps submit disabled
   */
  const handleFileChange = useCallback((e) => {
    const selected = e.target.files?.[0] ?? null;

    // Always clear the previous error when the user picks a new file
    setError(null);

    if (!selected) {
      setFile(null);
      setSubmitDisabled(true);
      return;
    }

    const validation = validateFile(selected);

    if (!validation.valid) {
      setFile(null);
      setError(validation.message);
      setSubmitDisabled(true);
      return;
    }

    // File is valid
    setFile(selected);
    setSubmitDisabled(false);
  }, []);

  /**
   * handleUpload(uploadFn)
   *
   * Executes the upload with full UX lifecycle management.
   * Pass in your API call as `uploadFn` — this keeps the hook
   * agnostic to the specific endpoint (sync vs async).
   *
   * UX contract:
   *   1. Re-validates before calling API (defence-in-depth)
   *   2. Disables submit + shows loading during API call
   *   3. On UNAUTHORIZED  → redirects to /login
   *   4. On other errors  → shows inline error, re-enables submit
   *   5. On success       → calls onSuccess callback
   *   6. Always clears loading state in finally
   *
   * @param {(file: File) => Promise<any>} uploadFn
   */
  const handleUpload = useCallback(async (uploadFn) => {
    // Defence: re-validate in case state got out of sync
    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.message);
      setSubmitDisabled(true);
      return;
    }

    setIsLoading(true);
    setSubmitDisabled(true);
    setError(null);

    try {
      const result = await uploadFn(file);
      onSuccess?.(result);
    } catch (err) {
      const code    = err?.response?.data?.code
                   ?? err?.response?.data?.error
                   ?? null;
      const message = err?.response?.data?.message ?? null;

      if (code === 'UNAUTHORIZED') {
        router.push('/login');
        return; // don't re-enable submit — we're navigating away
      }

      const uiMessage = mapBackendError(code, message);
      setError(uiMessage);
      onError?.(err);
    } finally {
      setIsLoading(false);
      setSubmitDisabled(false); // always re-enable after attempt
    }
  }, [file, router, onSuccess, onError]);

  /**
   * reset
   * Clears all state back to initial. Call after a successful upload
   * if the component stays mounted, or on modal close.
   */
  const reset = useCallback(() => {
    setFile(null);
    setError(null);
    setIsLoading(false);
    setSubmitDisabled(true);
  }, []);

  return {
    file,
    error,
    isLoading,
    isSubmitDisabled,
    handleFileChange,
    handleUpload,
    reset,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// USAGE EXAMPLES
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── SYNC UPLOAD (onboarding) ─────────────────────────────────────────────────
 *
 *   // POST /api/v1/onboarding/upload-cv
 *   import { useFileUpload } from '@/hooks/useFileUpload';
 *   import { onboardingApi }  from '@/services/onboarding.api';
 *
 *   function OnboardingUploadCv({ onComplete }) {
 *     const { file, error, isLoading, isSubmitDisabled,
 *             handleFileChange, handleUpload } = useFileUpload({
 *       onSuccess: (result) => onComplete(result.parsedData),
 *     });
 *
 *     const submit = () =>
 *       handleUpload((file) => onboardingApi.uploadCv(file));
 *
 *     return (
 *       <div>
 *         <input
 *           type="file"
 *           accept=".pdf,.doc,.docx,.txt"
 *           onChange={handleFileChange}
 *           className={error ? 'input-error' : ''}
 *         />
 *         {error && <p className="error-message">{error}</p>}
 *         <button onClick={submit} disabled={isSubmitDisabled || isLoading}>
 *           {isLoading ? 'Uploading…' : 'Upload CV'}
 *         </button>
 *       </div>
 *     );
 *   }
 *
 *
 * ── ASYNC UPLOAD (/resumes) ──────────────────────────────────────────────────
 *
 *   // POST /api/v1/resumes
 *   import { useFileUpload } from '@/hooks/useFileUpload';
 *   import { resumeApi }      from '@/services/resume.api';
 *
 *   function ResumeUploadForm({ onQueued }) {
 *     const { file, error, isLoading, isSubmitDisabled,
 *             handleFileChange, handleUpload, reset } = useFileUpload({
 *       onSuccess: ({ jobId }) => {
 *         onQueued(jobId);   // start polling GET /resumes/:id/status
 *         reset();
 *       },
 *     });
 *
 *     const submit = () =>
 *       handleUpload((file) => resumeApi.upload(file));
 *
 *     return (
 *       <div>
 *         <input
 *           type="file"
 *           accept=".pdf,.doc,.docx,.txt"
 *           onChange={handleFileChange}
 *           className={error ? 'input-error' : ''}
 *         />
 *         {error && <p className="error-message">{error}</p>}
 *         <button onClick={submit} disabled={isSubmitDisabled || isLoading}>
 *           {isLoading ? 'Queuing…' : 'Upload Resume'}
 *         </button>
 *       </div>
 *     );
 *   }
 */