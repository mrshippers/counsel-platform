import { Hono } from "hono";
import type { AppEnv } from "../index";

export const documentsRoutes = new Hono<AppEnv>();
