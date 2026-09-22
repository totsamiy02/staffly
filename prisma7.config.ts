import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "prisma/config";

if (existsSync("src/server/.env")) loadEnvFile("src/server/.env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
