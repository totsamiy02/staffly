import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "prisma/config";

const prismaEnvFile = process.env.PRISMA_ENV_FILE ?? "src/server/.env";
if (existsSync(prismaEnvFile)) loadEnvFile(prismaEnvFile);

const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
if (databaseUrl?.hostname === "localhost") databaseUrl.hostname = "127.0.0.1";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl?.toString(),
  },
});
