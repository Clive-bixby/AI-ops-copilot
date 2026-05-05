import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  aiHealthController,
  testEmbeddingController,
  testChunkController,
  testIndexController,
  testSearchController,
} from "./ai.controller.js";

const aiRouter = Router();

// Health check — no auth required (useful for monitoring)
aiRouter.get("/health", aiHealthController);

// Test endpoint — no auth for Day 1 development; lock down in production
aiRouter.post("/test-embedding", testEmbeddingController);

// Test endpoint — Day 2 chunking verification; lock down in production
aiRouter.post("/test-chunk", testChunkController);

// Test endpoint for Day 3 vector indexing, scoped to the active org
aiRouter.post("/test-index", authMiddleware, orgMiddleware, testIndexController);

// Test endpoint for Day 3 vector similarity search, scoped to the active org
aiRouter.post("/test-search", authMiddleware, orgMiddleware, testSearchController);

export default aiRouter;
