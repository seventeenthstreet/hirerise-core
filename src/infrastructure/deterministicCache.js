/**
 * deterministicCache.js
 * --------------------------------------------------------
 * Lightweight In-Memory Cache for Deterministic Scoring
 * --------------------------------------------------------
 * - Caches deterministic layer outputs only
 * - Supports TTL expiration
 * - Supports manual invalidation
 * - Non-blocking
 * - Swappable with Redis in future
 * --------------------------------------------------------
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class DeterministicCache {
    constructor() {
        this.store = new Map();
    }

    /**
     * Generate hash key from structured input
     */
    generateKey(payload) {
        const stringified = JSON.stringify(payload);
        return crypto.createHash('sha256').update(stringified).digest('hex');
    }

    /**
     * Set cache value
     */
    set(payload, value, ttl = DEFAULT_TTL_MS) {
        try {
            const key = this.generateKey(payload);
            const expiry = Date.now() + ttl;

            this.store.set(key, {
                value,
                expiry
            });

            return key;
        } catch (err) {
            console.error('DeterministicCache set error:', err.message);
            return null;
        }
    }

    /**
     * Get cache value
     */
    get(payload) {
        try {
            const key = this.generateKey(payload);
            const entry = this.store.get(key);

            if (!entry) return null;

            if (Date.now() > entry.expiry) {
                this.store.delete(key);
                return null;
            }

            return entry.value;
        } catch (err) {
            console.error('DeterministicCache get error:', err.message);
            return null;
        }
    }

    /**
     * Invalidate specific payload
     */
    invalidate(payload) {
        try {
            const key = this.generateKey(payload);
            return this.store.delete(key);
        } catch (err) {
            console.error('DeterministicCache invalidate error:', err.message);
            return false;
        }
    }

    /**
     * Clear entire cache (use cautiously)
     */
    clear() {
        this.store.clear();
    }

    /**
     * Cleanup expired entries (optional periodic job)
     */
    cleanup() {
        const now = Date.now();

        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expiry) {
                this.store.delete(key);
            }
        }
    }
}

module.exports = new DeterministicCache();









