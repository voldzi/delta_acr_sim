import type { Request, Response } from "express";

export function problem(req: Request, res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      code,
      message,
      correlationId: req.headers["x-correlation-id"] ?? crypto.randomUUID()
    }
  });
}
