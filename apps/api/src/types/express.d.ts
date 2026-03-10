import { Request } from "express"

export interface AuthRequest extends Request {
  user?: {
    id: string
  }
  organizationId?: string
  role?: "owner" | "admin" | "member"
}