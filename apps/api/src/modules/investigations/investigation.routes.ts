import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { aiRateLimiter } from "../../middleware/rateLimit.middleware.js";
import actionItemsRouter from "../actionItems/routes.js";
import {
  analyzeInvestigationController,
  askInvestigationQuestionController,
  collectInvestigationEvidenceController,
  createInvestigationController,
  createInvestigationCommentController,
  createInvestigationNoteController,
  getInvestigationAnalysisController,
  getInvestigationController,
  getInvestigationTimelineController,
  linkInvestigationEvidenceController,
  listInvestigationsController,
  listInvestigationQuestionsController,
  unlinkInvestigationEvidenceController,
  updateHypothesisController,
  updateInvestigationController,
} from "./investigation.controller.js";

const investigationsRouter = Router();

investigationsRouter.post(
  "/",
  authMiddleware,
  orgMiddleware,
  createInvestigationController
);

investigationsRouter.get(
  "/",
  authMiddleware,
  orgMiddleware,
  listInvestigationsController
);

investigationsRouter.get(
  "/:id",
  authMiddleware,
  orgMiddleware,
  getInvestigationController
);

investigationsRouter.patch(
  "/:id",
  authMiddleware,
  orgMiddleware,
  updateInvestigationController
);

// A read-only projection of the activity log and the evidence, in time order.
investigationsRouter.get(
  "/:id/timeline",
  authMiddleware,
  orgMiddleware,
  getInvestigationTimelineController
);

// Analysis is synchronous and calls the generation provider, so it shares the
// AI budget rather than the broad API budget.
investigationsRouter.post(
  "/:id/analyze",
  aiRateLimiter,
  authMiddleware,
  orgMiddleware,
  analyzeInvestigationController
);

investigationsRouter.get(
  "/:id/analysis",
  authMiddleware,
  orgMiddleware,
  getInvestigationAnalysisController
);

// Only the verdict is editable; the model's statement and rationale are not.
investigationsRouter.patch(
  "/:id/hypotheses/:hypothesisId",
  authMiddleware,
  orgMiddleware,
  updateHypothesisController
);

// Follow-up questions are answered from this investigation only, by the model.
investigationsRouter.post(
  "/:id/questions",
  aiRateLimiter,
  authMiddleware,
  orgMiddleware,
  askInvestigationQuestionController
);

investigationsRouter.get(
  "/:id/questions",
  authMiddleware,
  orgMiddleware,
  listInvestigationQuestionsController
);

// Notes are activity rows; they are written through their own endpoint so a
// note can never be mistaken for an investigation metadata update.
investigationsRouter.post(
  "/:id/notes",
  authMiddleware,
  orgMiddleware,
  createInvestigationNoteController
);

// Comments share the same append-only activity stream as notes but carry their
// own label, so the discussion feed can distinguish a record entry from a reply.
investigationsRouter.post(
  "/:id/comments",
  authMiddleware,
  orgMiddleware,
  createInvestigationCommentController
);

investigationsRouter.post(
  "/:id/evidence/collect",
  aiRateLimiter,
  authMiddleware,
  orgMiddleware,
  collectInvestigationEvidenceController
);

investigationsRouter.post(
  "/:id/evidence",
  authMiddleware,
  orgMiddleware,
  linkInvestigationEvidenceController
);

investigationsRouter.delete(
  "/:id/evidence/:evidenceId",
  authMiddleware,
  orgMiddleware,
  unlinkInvestigationEvidenceController
);

// Action items are durable follow-up work with their own event history. They
// are mounted here so every lookup is scoped by the parent investigation.
investigationsRouter.use("/:id/action-items", actionItemsRouter);

export default investigationsRouter;
