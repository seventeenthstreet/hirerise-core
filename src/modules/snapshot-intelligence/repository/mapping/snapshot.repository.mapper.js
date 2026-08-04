'use strict';

/**
 * @file core/src/modules/snapshot-intelligence/repository/mapping/snapshot.repository.mapper.js
 *
 * KR-02B-01 — Snapshot Repository Foundation
 *
 * Deterministic mapping between Repository DTOs (../dto) and the
 * certified domain Snapshot entity (domain/entities/snapshot.entities.js),
 * per KR-02B-01's "Repository Mapping Layer" deliverable.
 *
 * Per KR-02B-01's scope, there is no persistence model and no SQL model
 * in this milestone — mapping here is only ever DTO ↔ Entity, never
 * DTO ↔ storage-row. A future persistence adapter (KR-02B-02+) is
 * expected to layer its own storage-row ↔ DTO mapping underneath this
 * one, never bypass it.
 *
 * Both directions delegate final construction/validation to the
 * certified domain layer: `dtoToSnapshotEntity` calls
 * `domain.createSnapshot`, which applies every certified domain
 * validation rule and returns a deep-frozen entity. This mapper adds no
 * validation rules of its own beyond the repository-boundary structural
 * checks already performed by ../dto/snapshot.repository.dto.js — it is
 * pure, deterministic re-shaping, nothing more (KR-02B's "no business
 * rules" requirement).
 */

const domain = require('../../domain');
const { validateSnapshotCreateDTO } = require('../dto/snapshot.repository.dto');

/**
 * Maps a SnapshotCreateDTO to a domain Snapshot entity. Delegates to
 * `domain.createSnapshot`, which validates and deep-freezes the result —
 * this function performs the field re-shaping only.
 *
 * @param {import('../dto/snapshot.repository.dto').SnapshotCreateDTO} dto
 * @returns {import('../../domain/types/snapshot.types').Snapshot}
 */
function dtoToSnapshotEntity(dto) {
  validateSnapshotCreateDTO(dto);
  return domain.createSnapshot({
    id: dto.id,
    subject: dto.subject,
    scope: dto.scope,
    moment: dto.moment,
    context: dto.context,
    version: dto.version,
    state: dto.state,
    source: dto.source,
    ...(dto.confidence !== undefined ? { confidence: dto.confidence } : {}),
    trigger: dto.trigger,
    ...(dto.status !== undefined ? { status: dto.status } : {}),
    lifecycle: dto.lifecycle,
    supersessionState: dto.supersessionState,
    metadata: dto.metadata,
  });
}

/**
 * Maps a domain Snapshot entity to a SnapshotReadDTO — a full-fidelity,
 * plain-object, JSON-safe clone. The entity is already a deep-frozen
 * plain object matching this shape field-for-field, so this function's
 * only job is to hand back an independent (unfrozen, mutation-safe for
 * the caller) copy rather than the frozen entity reference itself, so
 * that no repository consumer can be handed something whose mutation
 * would throw.
 *
 * @param {import('../../domain/types/snapshot.types').Snapshot} snapshot
 * @returns {import('../dto/snapshot.repository.dto').SnapshotReadDTO}
 */
function snapshotEntityToReadDTO(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

/**
 * Convenience wrapper for mapping a list of domain Snapshot entities to
 * SnapshotReadDTOs, preserving order.
 *
 * @param {import('../../domain/types/snapshot.types').Snapshot[]} snapshots
 * @returns {import('../dto/snapshot.repository.dto').SnapshotReadDTO[]}
 */
function snapshotEntitiesToReadDTOs(snapshots) {
  return snapshots.map(snapshotEntityToReadDTO);
}

module.exports = {
  dtoToSnapshotEntity,
  snapshotEntityToReadDTO,
  snapshotEntitiesToReadDTOs,
};
