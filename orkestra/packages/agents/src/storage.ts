import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "@orkestra/config";
import crypto from "node:crypto";

let _client: S3Client | undefined;

function getClient(): S3Client {
  if (!_client) {
    const cfg = loadConfig();
    _client = new S3Client({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
    });
  }
  return _client;
}

export async function putObject(
  key: string,
  content: string | Buffer,
  contentType = "text/plain",
): Promise<{ key: string; hash: string; size: number }> {
  const cfg = loadConfig();
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  await getClient().send(
    new PutObjectCommand({
      Bucket: cfg.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { key, hash, size: body.length };
}

export async function getObject(key: string): Promise<string> {
  const cfg = loadConfig();
  const resp = await getClient().send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
  const body = await resp.Body!.transformToString("utf8");
  return body;
}

export async function getObjectSafe(key: string): Promise<string | null> {
  try {
    return await getObject(key);
  } catch {
    return null;
  }
}
