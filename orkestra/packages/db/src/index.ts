import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

let _client: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!_client) {
    _client = new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "info", "warn", "error"]
          : ["warn", "error"],
    });
  }
  return _client;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.$disconnect();
    _client = undefined;
  }
}
