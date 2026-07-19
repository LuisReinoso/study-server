import type { Request, Response, NextFunction } from "express";

/**
 * Builds an auth middleware for /api/*. If `token` is empty/undefined, auth
 * is disabled entirely (backward compatible with pre-token deployments).
 * Otherwise every request must carry `Authorization: Bearer <token>`.
 */
export function createAuthMiddleware(token: string | undefined) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!token) {
      next();
      return;
    }

    const header = req.header("authorization");
    if (header === `Bearer ${token}`) {
      next();
      return;
    }

    res.status(401).json({ error: "unauthorized" });
  };
}
