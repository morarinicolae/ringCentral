import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../db';

// Augment Express Request with the resolved seller (for seller endpoints).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      seller?: { id: string; name: string };
    }
  }
}

/**
 * Admin auth (MVP): a shared token in the `X-Admin-Token` header must match
 * ADMIN_API_TOKEN. Fails closed when no token is configured.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('x-admin-token');
  if (!config.adminApiToken) {
    res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_API_TOKEN is not configured.' });
    return;
  }
  if (token !== config.adminApiToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

/**
 * Seller auth (MVP): the seller identifies via `X-Seller-Id`. The seller must
 * exist. Downstream handlers MUST filter data by req.seller.id so a seller can
 * only ever see their own conversations (rule 7).
 */
export async function requireSeller(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sellerId = req.header('x-seller-id');
  if (!sellerId) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing X-Seller-Id header.' });
    return;
  }
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) {
    res.status(401).json({ error: 'unauthorized', message: 'Unknown seller.' });
    return;
  }
  req.seller = { id: seller.id, name: seller.name };
  next();
}
