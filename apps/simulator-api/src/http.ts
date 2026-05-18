import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";

export function problem(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details: unknown[] = []
): void {
  res.status(status).json({
    error: {
      code,
      message,
      details,
      correlationId: req.header("x-correlation-id") ?? randomUUID()
    }
  });
}

export function ok(res: Response, data: unknown): void {
  res.json(data);
}
