'use strict';

jest.mock('../repositories/sourceRelationship.repository');
jest.mock('../repositories/sourceRegistry.repository');
jest.mock('../repositories/sourceAudit.repository');
jest.mock('../events/sim.events');

const relationshipRepo = require('../repositories/sourceRelationship.repository');
const sourceRegistryRepo = require('../repositories/sourceRegistry.repository');
const auditRepo = require('../repositories/sourceAudit.repository');
const simEvents = require('../events/sim.events');
const {
  addRelationship,
  listRelationships,
  removeRelationship,
} = require('../services/sourceRelationship.service');

const SOURCE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SOURCE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeEach(() => {
  jest.resetAllMocks();
  simEvents.SIM_EVENT_TYPES = {
    SOURCE_RELATIONSHIP_ADDED: 'SIM.SOURCE_RELATIONSHIP_ADDED',
    SOURCE_RELATIONSHIP_REMOVED: 'SIM.SOURCE_RELATIONSHIP_REMOVED',
  };
  simEvents.emit = jest.fn().mockResolvedValue(undefined);
  auditRepo.record = jest.fn().mockResolvedValue(undefined);
});

describe('SIM sourceRelationship.service', () => {
  describe('addRelationship', () => {
    it('rejects an unrecognized relationship type', async () => {
      await expect(
        addRelationship(SOURCE_A, { relatedSourceId: SOURCE_B, relationshipType: 'cousin' })
      ).rejects.toThrow(/recognized SIM relationship type/);
    });

    it('rejects a self-relationship', async () => {
      await expect(
        addRelationship(SOURCE_A, { relatedSourceId: SOURCE_A, relationshipType: 'mirror' })
      ).rejects.toThrow(/cannot have a relationship with itself/);
    });

    it('404s when the source itself does not exist', async () => {
      sourceRegistryRepo.findById = jest.fn().mockResolvedValue(null);

      await expect(
        addRelationship(SOURCE_A, { relatedSourceId: SOURCE_B, relationshipType: 'mirror' })
      ).rejects.toThrow(/not found/i);
    });

    it('404s when relatedSourceId does not reference an existing source', async () => {
      sourceRegistryRepo.findById = jest
        .fn()
        .mockImplementation((id) => Promise.resolve(id === SOURCE_A ? { id: SOURCE_A } : null));

      await expect(
        addRelationship(SOURCE_A, { relatedSourceId: SOURCE_B, relationshipType: 'mirror' })
      ).rejects.toThrow(/relatedSourceId does not reference/);
    });

    it('rejects an exact duplicate relationship', async () => {
      sourceRegistryRepo.findById = jest.fn().mockResolvedValue({ id: 'x' });
      relationshipRepo.findExact = jest.fn().mockResolvedValue({ id: 'existing-rel' });

      await expect(
        addRelationship(SOURCE_A, { relatedSourceId: SOURCE_B, relationshipType: 'backup' })
      ).rejects.toThrow(/already exists/);
    });

    it('creates the relationship, writes an audit record, and emits an event', async () => {
      sourceRegistryRepo.findById = jest.fn().mockResolvedValue({ id: 'x' });
      relationshipRepo.findExact = jest.fn().mockResolvedValue(null);
      relationshipRepo.create = jest.fn().mockResolvedValue({
        id: 'rel-1',
        sourceId: SOURCE_A,
        relatedSourceId: SOURCE_B,
        relationshipType: 'depends_on',
      });

      const result = await addRelationship(
        SOURCE_A,
        { relatedSourceId: SOURCE_B, relationshipType: 'depends_on' },
        { actorId: 'admin-1' }
      );

      expect(result.id).toBe('rel-1');
      expect(relationshipRepo.create).toHaveBeenCalledWith(
        { sourceId: SOURCE_A, relatedSourceId: SOURCE_B, relationshipType: 'depends_on', notes: null },
        'admin-1'
      );
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: SOURCE_A, action: 'RELATIONSHIP_ADDED' })
      );
      expect(simEvents.emit).toHaveBeenCalledWith(
        'SIM.SOURCE_RELATIONSHIP_ADDED',
        expect.objectContaining({ sourceId: SOURCE_A, relatedSourceId: SOURCE_B })
      );
    });
  });

  describe('listRelationships', () => {
    it('404s when the source does not exist', async () => {
      sourceRegistryRepo.findById = jest.fn().mockResolvedValue(null);
      await expect(listRelationships(SOURCE_A)).rejects.toThrow(/not found/i);
    });

    it('returns both inbound and outbound edges from the repository', async () => {
      sourceRegistryRepo.findById = jest.fn().mockResolvedValue({ id: SOURCE_A });
      relationshipRepo.listForSource = jest.fn().mockResolvedValue([
        { id: 'rel-1', direction: 'outbound' },
        { id: 'rel-2', direction: 'inbound' },
      ]);

      const result = await listRelationships(SOURCE_A);
      expect(result).toHaveLength(2);
    });
  });

  describe('removeRelationship', () => {
    it('404s when the relationship does not belong to this source', async () => {
      relationshipRepo.findById = jest
        .fn()
        .mockResolvedValue({ id: 'rel-1', sourceId: SOURCE_B });

      await expect(removeRelationship(SOURCE_A, 'rel-1')).rejects.toThrow(/not found/i);
    });

    it('removes the relationship and audits + emits on success', async () => {
      relationshipRepo.findById = jest.fn().mockResolvedValue({
        id: 'rel-1',
        sourceId: SOURCE_A,
        relatedSourceId: SOURCE_B,
        relationshipType: 'mirror',
      });
      relationshipRepo.remove = jest.fn().mockResolvedValue({ id: 'rel-1' });

      const result = await removeRelationship(SOURCE_A, 'rel-1', { actorId: 'admin-1' });

      expect(result).toEqual({ id: 'rel-1' });
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: SOURCE_A, action: 'RELATIONSHIP_REMOVED' })
      );
      expect(simEvents.emit).toHaveBeenCalledWith(
        'SIM.SOURCE_RELATIONSHIP_REMOVED',
        expect.objectContaining({ sourceId: SOURCE_A })
      );
    });
  });
});
