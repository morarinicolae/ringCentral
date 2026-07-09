import { prisma, Tx } from '../db';
import { ActorType } from '../types';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Append an immutable audit-log row. Accepts an optional transaction client so
 * the audit write commits atomically with the change it describes.
 */
export async function writeAudit(entry: AuditEntry, tx: Tx | typeof prisma = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      detailsJson: entry.details ? JSON.stringify(entry.details) : null,
    },
  });
}
