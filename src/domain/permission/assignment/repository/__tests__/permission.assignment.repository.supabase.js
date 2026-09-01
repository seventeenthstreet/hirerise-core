'use strict';

/**
 * @file src/domain/permission/assignment/repository/permission.assignment.repository.supabase.js
 *
 * BLOCKER 3C — Permission Assignment Persistence
 *
 * Concrete Supabase implementation of ./permission.assignment.repository.interface.js,
 * persisting to `public.permission_assignments`
 * (supabase/migrations/20260825090000_wp_admin_04f_20_permission_assignment_persistence.sql).
 *
 * Follows the exact "manual Supabase query + lazy getSupabase()" repository
 * convention already established by
 * ../../repository/permission.repository.js (SupabasePermissionRepository)
 * — no ORM, no BaseRepository inheritance, a single flat table.
 *
 * PERSISTENCE ONLY, per the Blocker 3C audit's Target Architecture:
 *
 *   PermissionAssignmentService -> AssignmentRepository interface -> this file
 *
 * This repository never touches Permission Registry, Evaluation,
 * Governance, or `admin_principals`. It stores/retrieves Assignment rows
 * exactly as the Service hands them, and reconstructs the same frozen
 * Assignment shape on read through the one certified domain factory
 * (../permission.assignment.model.js#createAssignment) — so
 * assignmentIdentity/permissionIdentity are always derived identically,
 * regardless of backing store. It never re-implements Assignment
 * validation, Permission-existence checks, or Assignment Policy
 * grantability — those remain PermissionAssignmentService's job
 * (permission.assignment.service.js), unchanged by this file.
 *
 * ── Duplicate protection is a database guarantee, not an app-level guess ──
 * `permission_assignments_identity_key` (UNIQUE on `assignment_identity`)
 * is the actual multi-instance-safe mechanism (Blocker 3C §7/§13).
 * `create()` below does not pre-check for an existing row; it attempts a
 * plain insert and maps a Postgres unique-violation (SQLSTATE 23505) into
 * the same `DuplicateAssignmentError` the in-memory repository already
 * throws for this exact case
 * (../repository/permission.assignment.repository.inMemory.js#create) —
 * preserving exact behavioral parity. `PermissionAssignmentService`'s own
 * find-then-create idempotency layer (permission.assignment.service.js's
 * `assignPermission()`) is unchanged by this file: this repository is a
 * strict `create()`, exactly like the interface it implements requires;
 * idempotent grant-or-return remains the Service's responsibility, layered
 * on top.
 */

const { AssignmentRepository } = require('./permission.assignment.repository.interface');
const { createAssignment } = require('../permission.assignment.model');
const {
  DuplicateAssignmentError,
  AssignmentNotFoundError,
  PermissionAssignmentError,
} = require('../permission.assignment.errors');

const TABLE = 'permission_assignments';
const POSTGRES_UNIQUE_VIOLATION = '23505';

// Lazy require, matching permission.repository.js's own convention —
// avoids a load-order dependency on config/supabase.js at module-require
// time (config/supabase.js throws synchronously if its env vars are
// absent) and keeps this module mockable via jest.mock('.../config/supabase').
function getSupabase() {
  return require('../../../../config/supabase').supabase;
}

/**
 * Reconstructs the frozen Assignment shape from a stored row, through the
 * same domain factory every other Assignment code path already uses.
 * @private
 * @param {object} row
 * @returns {Readonly<import('../permission.assignment.model').Assignment>}
 */
function rowToAssignment(row) {
  return createAssignment({
    principalId: row.principal_id,
    resource: row.resource,
    action: row.action,
    assignedAt: row.assigned_at,
  });
}

/**
 * @implements {AssignmentRepository}
 */
class SupabaseAssignmentRepository extends AssignmentRepository {
  /**
   * @param {import('../permission.assignment.model').Assignment} assignment
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   * @throws {DuplicateAssignmentError} if a row already exists for `assignment.assignmentIdentity`
   */
  async create(assignment) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        principal_id: assignment.principalId,
        resource: assignment.resource,
        action: assignment.action,
        permission_identity: assignment.permissionIdentity,
        assignment_identity: assignment.assignmentIdentity,
        assigned_at: assignment.assignedAt,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new DuplicateAssignmentError(assignment.assignmentIdentity);
      }
      throw new PermissionAssignmentError(
        `Failed to create Assignment "${assignment.assignmentIdentity}": ${error.message}`,
        'ASSIGNMENT_REPOSITORY_CREATE_FAILED',
        { assignmentIdentity: assignment.assignmentIdentity },
      );
    }

    return rowToAssignment(data);
  }

  /**
   * Safe to call for an identity that does not exist — returns whether a
   * row was actually deleted, never throws for a missing identity.
   * @param {string} assignmentIdentity
   * @returns {Promise<boolean>}
   */
  async delete(assignmentIdentity) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .delete()
      .eq('assignment_identity', assignmentIdentity)
      .select('id');

    if (error) {
      throw new PermissionAssignmentError(
        `Failed to delete Assignment "${assignmentIdentity}": ${error.message}`,
        'ASSIGNMENT_REPOSITORY_DELETE_FAILED',
        { assignmentIdentity },
      );
    }

    return Array.isArray(data) && data.length > 0;
  }

  /**
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment | null>}
   */
  async find(assignmentIdentity) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('assignment_identity', assignmentIdentity)
      .maybeSingle();

    if (error) {
      throw new PermissionAssignmentError(
        `Failed to read Assignment "${assignmentIdentity}": ${error.message}`,
        'ASSIGNMENT_REPOSITORY_READ_FAILED',
        { assignmentIdentity },
      );
    }

    return data ? rowToAssignment(data) : null;
  }

  /**
   * Like `find`, but throws `AssignmentNotFoundError` instead of
   * returning null.
   * @param {string} assignmentIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment>}
   * @throws {AssignmentNotFoundError}
   */
  async get(assignmentIdentity) {
    const assignment = await this.find(assignmentIdentity);
    if (!assignment) {
      throw new AssignmentNotFoundError(assignmentIdentity);
    }
    return assignment;
  }

  /**
   * @param {string} principalId
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  async findByPrincipal(principalId) {
    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).select('*').eq('principal_id', principalId);

    if (error) {
      throw new PermissionAssignmentError(
        `Failed to list Assignments for principal "${principalId}": ${error.message}`,
        'ASSIGNMENT_REPOSITORY_READ_FAILED',
        { principalId },
      );
    }

    return (data ?? []).map(rowToAssignment);
  }

  /**
   * @param {string} permissionIdentity
   * @returns {Promise<import('../permission.assignment.model').Assignment[]>}
   */
  async findByPermission(permissionIdentity) {
    const supabase = getSupabase();
    const { data, error } = await supabase.from(TABLE).select('*').eq('permission_identity', permissionIdentity);

    if (error) {
      throw new PermissionAssignmentError(
        `Failed to list Assignments for permission "${permissionIdentity}": ${error.message}`,
        'ASSIGNMENT_REPOSITORY_READ_FAILED',
        { permissionIdentity },
      );
    }

    return (data ?? []).map(rowToAssignment);
  }

  /**
   * @returns {Promise<number>}
   */
  async count() {
    const supabase = getSupabase();
    const { count, error } = await supabase.from(TABLE).select('*', { count: 'exact', head: true });

    if (error) {
      throw new PermissionAssignmentError(`Failed to count Assignments: ${error.message}`, 'ASSIGNMENT_REPOSITORY_READ_FAILED');
    }

    return count ?? 0;
  }
}

module.exports = {
  SupabaseAssignmentRepository,
};
