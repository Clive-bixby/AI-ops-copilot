import { Router } from "express";

import {
  aiHealthController,
  testEmbeddingController,
  testChunkController,
} from "./ai.controller.js";

const aiRouter = Router();

// Health check — no auth required (useful for monitoring)
aiRouter.get("/health", aiHealthController);

// Test endpoint — no auth for Day 1 development; lock down in production
aiRouter.post("/test-embedding", testEmbeddingController);

// Test endpoint — Day 2 chunking verification; lock down in production
aiRouter.post("/test-chunk", testChunkController);

export default aiRouter;
