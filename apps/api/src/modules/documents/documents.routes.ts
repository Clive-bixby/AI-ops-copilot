import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";

import { logger } from "../../core/logger.js";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { orgMiddleware } from "../../middleware/org.middleware.js";
import { UnsupportedFileTypeError, upload } from "../../middleware/upload.middleware.js";
import { MAX_DOCUMENT_BYTES } from "../../config/limits.js";
import {
  createDocumentController,
  deleteDocumentController,
  getDocumentController,
  listDocumentsController,
  reprocessDocumentController,
} from "./documents.controller.js";

const documentsRouter = Router();

function uploadSingleFile(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      return next();
    }

    if (error instanceof UnsupportedFileTypeError) {
      return res.status(400).json({ error: error.message });
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: `File is too large. Maximum size is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
        });
      }

      if (error.code === "LIMIT_FILE_COUNT") {
        return res
          .status(400)
          .json({ error: "Only one file can be uploaded per request." });
      }

      if (error.code === "MISSING_FIELD_NAME") {
        return res.status(400).json({
          error:
            "Field name missing. Use multipart/form-data and add a file field named 'file'.",
        });
      }

      if (error.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          error: "Unexpected file field. Use field name 'file'.",
        });
      }

      return res.status(400).json({ error: error.message });
    }

    const unknownError =
      error instanceof Error ? error : new Error("Unknown upload error");
    logger.error("documents.upload_failed", {
      requestId: req.id,
      error: unknownError,
    });
    return res.status(500).json({ error: "File upload failed" });
  });
}

documentsRouter.get("/", authMiddleware, orgMiddleware, listDocumentsController);
documentsRouter.get(
  "/:id",
  authMiddleware,
  orgMiddleware,
  getDocumentController
);
documentsRouter.post(
  "/upload",
  authMiddleware,
  orgMiddleware,
  uploadSingleFile,
  createDocumentController
);
documentsRouter.post(
  "/:id/reprocess",
  authMiddleware,
  orgMiddleware,
  reprocessDocumentController
);
documentsRouter.delete(
  "/:id",
  authMiddleware,
  orgMiddleware,
  deleteDocumentController
);

export default documentsRouter;
