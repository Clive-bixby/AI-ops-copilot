import { Router } from "express";

import { devOnlyMiddleware } from "../../middleware/devOnly.middleware.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  askQuestion,
  aiHealthController,
  searchController,
  testEmbeddingController,
  testChunkController,
  testIndexController,
  testSearchController,
} from "./ai.controller.js";

const aiRouter = Router();

// Health check — no auth required (useful for monitoring)
aiRouter.get("/health", aiHealthController);

// Test endpoints are development tools. They require auth and an organization,
// and they answer 404 unless ENABLE_DEV_ENDPOINTS=true.
aiRouter.post(
  "/test-embedding",
  devOnlyMiddleware,
  authMiddleware,
  orgMiddleware,
  testEmbeddingController
);

aiRouter.post(
  "/test-chunk",
  devOnlyMiddleware,
  authMiddleware,
  orgMiddleware,
  testChunkController
);

aiRouter.post(
  "/test-index",
  devOnlyMiddleware,
  authMiddleware,
  orgMiddleware,
  testIndexController
);

aiRouter.post(
  "/test-search",
  devOnlyMiddleware,
  authMiddleware,
  orgMiddleware,
  testSearchController
);

// Production semantic search, scoped to the active organization
aiRouter.post("/search", authMiddleware, orgMiddleware, searchController);

// Production RAG question answering, scoped to the active organization
aiRouter.post("/ask", authMiddleware, orgMiddleware, askQuestion);

export default aiRouter;
