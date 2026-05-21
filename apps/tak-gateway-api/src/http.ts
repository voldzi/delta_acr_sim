import type { Request, Response as ExpressResponse } from "express";

export function problem(req: Request, res: ExpressResponse, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      code,
      message,
      correlationId: req.headers["x-correlation-id"] ?? crypto.randomUUID()
    }
  });
}
