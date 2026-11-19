import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { authRateLimiter } from "../../middleware/rateLimit.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  loginController,
  meController,
  registerController,
} from "./auth.controller.js";

const authRouter = Router();

// Credential endpoints get a stricter budget than the rest of the API.
authRouter.post("/register", authRateLimiter, registerController);
authRouter.post("/login", authRateLimiter, loginController);
authRouter.get("/me", authMiddleware, orgMiddleware, meController);

export default authRouter;
