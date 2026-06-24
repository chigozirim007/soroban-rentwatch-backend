import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.logging.level,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
  base: { service: "soroban-rentwatch" },
});
