import { asyncHandler } from "../../utils/asyncHandler.js";
import { login, register } from "./auth.service.js";

export const registerController = asyncHandler(async (req, res) => {
  const result = await register(req.body);
  return res.status(201).json(result);
});

export const loginController = asyncHandler(async (req, res) => {
  const result = await login(req.body);
  return res.status(200).json(result);
});
