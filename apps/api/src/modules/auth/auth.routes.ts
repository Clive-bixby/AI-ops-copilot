import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  loginController,
  meController,
  registerController,
} from "./auth.controller.js";

const authRouter = Router();

authRouter.post("/register", registerController);
authRouter.post("/login", loginController);
authRouter.get("/me", authMiddleware, orgMiddleware, meController);

export default authRouter;
