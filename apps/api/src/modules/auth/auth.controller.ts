import type { Request, Response } from "express";

import {
  AuthConfigError,
  AuthConflictError,
  AuthUnauthorizedError,
  AuthValidationError,
  login,
  register,
} from "./auth.service.js";

export async function registerController(req: Request, res: Response) {
  try {
    const result = await register(req.body);
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof AuthValidationError) {
      return res.status(400).json({ error: error.message });
    }

    if (error instanceof AuthConflictError) {
      return res.status(409).json({ error: error.message });
    }

    if (error instanceof AuthConfigError) {
      return res.status(500).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("Register failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function loginController(req: Request, res: Response) {
  try {
    const result = await login(req.body);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof AuthValidationError) {
      return res.status(400).json({ error: error.message });
    }

    if (error instanceof AuthUnauthorizedError) {
      return res.status(401).json({ error: error.message });
    }

    if (error instanceof AuthConfigError) {
      return res.status(500).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown error");
    console.error("Login failed:", unknownError);
    return res.status(500).json({ error: "Internal server error" });
  }
}
