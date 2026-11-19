import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

import { MAX_DOCUMENT_BYTES } from "../config/limits.js";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const uploadDir = path.resolve(currentDirPath, "../../uploads");

fs.mkdirSync(uploadDir, { recursive: true });

/** Formats the parser can extract text from. Everything else is rejected here. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  ".txt",
  ".csv",
  ".md",
  ".json",
  ".log",
  ".tsv",
  ".pdf",
] as const;

export class UnsupportedFileTypeError extends Error {
  constructor(filename: string) {
    super(
      `Unsupported file type for "${filename}". Allowed extensions: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}`
    );
    this.name = "UnsupportedFileTypeError";
  }
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename: function (_req, file, cb) {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, uniqueName + path.extname(file.originalname));
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_DOCUMENT_BYTES,
    files: 1,
    fields: 10,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();

    if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      cb(new UnsupportedFileTypeError(file.originalname || "upload"));
      return;
    }

    cb(null, true);
  },
});
