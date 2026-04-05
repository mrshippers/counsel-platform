import { Hono } from "hono";
import type { AppEnv } from "../index";

export const exportRoutes = new Hono<AppEnv>();
