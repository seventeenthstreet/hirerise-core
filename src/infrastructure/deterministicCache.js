'use strict';

/**
 * Deterministic Cache (Production Optimized)
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// 🔹 CONFIG
// ─────────────────────────────────────────────

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

// ─────────────────────────────────────────────
// 🔹 STABLE STRINGIFY (IMPORTANT FIX)
// ─────────────────────────────────────────────

function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
        return `[${obj.map(stableStringify).join(',')}]`;
    }

    return `{${Object.keys(obj)
        .sort()
        .map(key => `"${key}":${stableStringify(obj[key])}`)
        .join(',')}}`;
}

// ─────────────────────────────────────────────
// 🔹 CACHE CLASS
// ─────────────────────────────────────────────

class DeterministicCache {
    constructor() {
        this.store = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    generateKey(payload) {
        const stringified = stableStringify(payload);
        return crypto.createHash('sha256').update(stringified).digest('hex');
    }

    set(payload, value, ttl = DEFAULT_TTL_MS) {
        try {
            if (this.store.size >= MAX_ENTRIES) {
                this.evictOldest();
            }

            const key = this.generateKey(payload);
            const expiry = Date.now() + ttl;

            this.store.set(key, {
                value,
                expiry,
                createdAt: Date.now()
            });

            return key;
        } catch (err) {
            logger.warn('DeterministicCache set error', { error: err.message });
            return null;
        }
    }

    get(payload) {
        try {
            const key = this.generateKey(payload);
            const entry = this.store.get(key);

            if (!entry) {
                this.misses++;
                return null;
            }

            if (Date.now() > entry.expiry) {
                this.store.delete(key);
                this.misses++;
                return null;
            }

            this.hits++;
            return entry.value;
        } catch (err) {
            logger.warn('DeterministicCache get error', { error: err.message });
            return null;
        }
    }

    invalidate(payload) {
        try {
            const key = this.generateKey(payload);
            return this.store.delete(key);
        } catch (err) {
            logger.warn('DeterministicCache invalidate error', { error: err.message });
            return false;
        }
    }

    clear() {
        this.store.clear();
        this.hits = 0;
        this.misses = 0;
    }

    cleanup() {
        const now = Date.now();

        for (const [key, entry] of this.store.entries()) {
            if (now > entry.expiry) {
                this.store.delete(key);
            }
        }
    }

    evictOldest() {
        const firstKey = this.store.keys().next().value;
        if (firstKey) {
            this.store.delete(firstKey);
        }
    }

    getStats() {
        return {
            size: this.store.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits / (this.hits + this.misses || 1)
        };
    }
}

module.exports = new DeterministicCache();