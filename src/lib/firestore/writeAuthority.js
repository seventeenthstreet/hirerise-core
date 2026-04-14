'use strict';

const logger = require('../logger');

const writeAuthority = {
  leaderRegion: process.env.PRIMARY_REGION || 'ap-south-1',
  epoch: Date.now(),
  sequence: new Map(),
};

function nextSequence(docPath) {
  const next = (writeAuthority.sequence.get(docPath) || 0) + 1;
  writeAuthority.sequence.set(docPath, next);
  return next;
}

async function authoritativeWrite({
  db,
  region,
  path,
  payload,
  expectedVersion,
}) {
  if (region !== writeAuthority.leaderRegion) {
    throw new Error(
      `[Patch44] Split-brain prevented: ${region} is not write leader`
    );
  }

  const ref = db.doc(path);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : {};
    const currentVersion = current.version || 0;

    if (
      expectedVersion !== undefined &&
      currentVersion !== expectedVersion
    ) {
      throw new Error(
        `[Patch44] Version conflict on ${path}`
      );
    }

    tx.set(
      ref,
      {
        ...payload,
        version: currentVersion + 1,
        mutationSeq: nextSequence(path),
        authorityRegion: region,
        authorityEpoch: writeAuthority.epoch,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  });

  logger.info('[Patch44] Firestore authoritative write committed', {
    path,
    region,
  });
}

module.exports = {
  authoritativeWrite,
  writeAuthority,
};