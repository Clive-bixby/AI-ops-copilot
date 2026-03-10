import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

type AuthenticatedUser = {
  id: string;
};

type DecodedToken = {
  userId?: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({ error: "JWT_SECRET is not configured" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as DecodedToken;

    if (!decoded || typeof decoded.userId !== "string") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.user = {
      id: decoded.userId,
    };

    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

