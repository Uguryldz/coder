import { createLogger, loadConfig } from "@orkestra/config";
import { Client, Connection } from "@temporalio/client";

const log = createLogger("temporal-client");

let _client: Client | undefined;

export async function getTemporalClient(): Promise<Client> {
  if (_client) return _client;
  const cfg = loadConfig();
  const connection = await Connection.connect({ address: cfg.TEMPORAL_ADDRESS });
  _client = new Client({ connection, namespace: cfg.TEMPORAL_NAMESPACE });
  log.info({ address: cfg.TEMPORAL_ADDRESS }, "temporal client connected");
  return _client;
}
