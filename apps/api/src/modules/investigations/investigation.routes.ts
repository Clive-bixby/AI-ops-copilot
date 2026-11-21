import { Router } from "express";

import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import {
  collectInvestigationEvidenceController,
  createInvestigationController,
  createInvestigationNoteController,
  getInvestigationController,
  getInvestigationTimelineController,
  linkInvestigationEvidenceController,
  listInvestigationsController,
  unlinkInvestigationEvidenceController,
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

// Notes are activity rows; they are written through their own endpoint so a
// note can never be mistaken for an investigation metadata update.
investigationsRouter.post(
  "/:id/notes",
  authMiddleware,
  orgMiddleware,
  createInvestigationNoteController
);

investigationsRouter.post(
  "/:id/evidence/collect",
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

export default investigationsRouter;
