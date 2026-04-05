import { Hono } from "hono";
import type { AppEnv } from "../index";

export const gdprRoutes = new Hono<AppEnv>();
