import { logger } from "../../core/logger.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { createHttpError } from "../../utils/httpError.js";
import {
  collectInvestigationEvidence,
  linkInvestigationEvidence,
  unlinkInvestigationEvidence,
} from "./evidence.service.js";
import {
  addInvestigationNote,
  createInvestigation,
  getInvestigationDetail,
  listInvestigations,
  updateInvestigation,
} from "./investigation.service.js";
import { getInvestigationTimeline } from "./timeline.service.js";
import type { EvidenceCollectionSummary } from "./types.js";

function requireOrganization(organizationId: string | undefined): string {
  if (!organizationId) {
    throw createHttpError(400, "Organization ID is required");
  }

  return organizationId;
}

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  return userId;
}

function readRouteId(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

/**
 * A collection attempt that failed after the investigation was created. The
 * creation is real, so the response says what happened instead of pretending the
 * search ran and found nothing.
 */
function failedCollection(error: unknown): EvidenceCollectionSummary {
  return {
    failed: true,
    queries: [],
    added: 0,
    existing: 0,
    filteredOut: 0,
    warnings: [
      error instanceof Error
        ? `Evidence collection failed: ${error.message}`
        : "Evidence collection failed.",
    ],
  };
}

export const createInvestigationController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const { detail, collectEvidenceRequested } = await createInvestigation({
    organizationId,
    userId,
    payload: req.body,
  });

  if (!collectEvidenceRequested) {
    return res.status(201).json({ ...detail, collection: null });
  }

  try {
    const result = await collectInvestigationEvidence({
      organizationId,
      investigationId: detail.investigation.id,
      userId,
    });

    const fresh = await getInvestigationDetail(
      organizationId,
      detail.investigation.id
    );

    return res.status(201).json({ ...fresh, collection: result.summary });
  } catch (error) {
    logger.warn("investigation.create_collection_failed", {
      organizationId,
      investigationId: detail.investigation.id,
      error,
    });

    return res.status(201).json({
      ...detail,
      collection: failedCollection(error),
    });
  }
});

export const listInvestigationsController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);

  const result = await listInvestigations({
    organizationId,
    query: req.query,
  });

  return res.status(200).json(result);
});

export const getInvestigationController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);

  const detail = await getInvestigationDetail(
    organizationId,
    readRouteId(req.params.id)
  );

  return res.status(200).json(detail);
});

export const updateInvestigationController = asyncHandler(async (req, res) => {
  const organizationId = requireOrganization(req.organizationId);
  const userId = requireUserId(req.user?.id);

  const detail = await updateInvestigation({
    organizationId,
    investigationId: readRouteId(req.params.id),
    userId,
    payload: req.body,
  });

  return res.status(200).json(detail);
});

export const createInvestigationNoteController = asyncHandler(
  async (req, res) => {
    const organizationId = requireOrganization(req.organizationId);
    const userId = requireUserId(req.user?.id);

    const activity = await addInvestigationNote({
      organizationId,
      investigationId: readRouteId(req.params.id),
      userId,
      payload: req.body,
    });

    return res.status(201).json({ activity });
  }
);

/**
 * GET /investigations/:id/timeline
 *
 * Activity and evidence merged into one chronological list, with deterministic
 * correlation labels. Derived on read, so it cannot drift from the evidence.
 */
export const getInvestigationTimelineController = asyncHandler(
  async (req, res) => {
    const organizationId = requireOrganization(req.organizationId);

    const timeline = await getInvestigationTimeline(
      organizationId,
      readRouteId(req.params.id)
    );

    return res.status(200).json(timeline);
  }
);

/**
 * POST /investigations/:id/evidence/collect
 *
 * Searches the organization's indexed documents, tickets and log groups, resolves
 * each hit to its real source, grades it and stores the new evidence. Refreshing
 * is idempotent: existing sources are reported as `existing`, not duplicated.
 */
export const collectInvestigationEvidenceController = asyncHandler(
  async (req, res) => {
    const organizationId = requireOrganization(req.organizationId);
    const userId = requireUserId(req.user?.id);

    const result = await collectInvestigationEvidence({
      organizationId,
      investigationId: readRouteId(req.params.id),
      userId,
    });

    const detail = await getInvestigationDetail(
      organizationId,
      result.investigationId
    );

    return res.status(200).json({ ...detail, collection: result.summary });
  }
);

/** POST /investigations/:id/evidence — link a known source by id. */
export const linkInvestigationEvidenceController = asyncHandler(
  async (req, res) => {
    const organizationId = requireOrganization(req.organizationId);
    const userId = requireUserId(req.user?.id);

    const result = await linkInvestigationEvidence({
      organizationId,
      investigationId: readRouteId(req.params.id),
      userId,
      payload: req.body,
    });

    const detail = await getInvestigationDetail(
      organizationId,
      result.investigationId
    );

    return res.status(result.added ? 201 : 200).json({
      ...detail,
      added: result.added,
    });
  }
);

/** DELETE /investigations/:id/evidence/:evidenceId */
export const unlinkInvestigationEvidenceController = asyncHandler(
  async (req, res) => {
    const organizationId = requireOrganization(req.organizationId);
    const userId = requireUserId(req.user?.id);

    await unlinkInvestigationEvidence({
      organizationId,
      investigationId: readRouteId(req.params.id),
      evidenceId: readRouteId(req.params.evidenceId),
      userId,
    });

    return res.status(204).send();
  }
);
