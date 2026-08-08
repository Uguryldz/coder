import { PublishReceipt, PublishRequest, type PublishTarget } from "@maestro/contracts";
import { CapabilityNotSupportedError, type PublishPort } from "@maestro/ports";
import { PublishRenderError } from "./errors.js";
import type { TargetPublisher } from "./types.js";

/** Registry port name (M44). */
export const PUBLISH_PORT = "publish";

/**
 * docx/pdf are in the contract but belong to Aşama 2 (M103). They fail LOUDLY:
 * a target silently dropped from `req.targets` would leave a run believing the
 * board got its file.
 */
export class UnsupportedTargetPublisher implements TargetPublisher {
  constructor(readonly target: PublishTarget) {}

  publish(): Promise<PublishReceipt> {
    return Promise.reject(new CapabilityNotSupportedError(PUBLISH_PORT, this.target));
  }
}

/**
 * `PublishPort` implementation that fans a request out over its targets
 * (M47: "hepsi olsun, esnek ve modüler"). Targets run in request order and one
 * failing target fails the publish — partial success would hand a run a
 * receipt list that silently misses a target.
 */
export class MaestroPublishPort implements PublishPort {
  constructor(private readonly publishers: Map<PublishTarget, TargetPublisher>) {}

  /** Targets this instance can actually serve (docx/pdf included, and refusing). */
  targets(): PublishTarget[] {
    return [...this.publishers.keys()];
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt[]> {
    const request = PublishRequest.parse(req);
    if (typeof markdownSource !== "string" || markdownSource.trim().length === 0) {
      throw new PublishRenderError("refusing to publish an empty document");
    }

    const receipts: PublishReceipt[] = [];
    for (const target of new Set(request.targets)) {
      const publisher = this.publishers.get(target);
      if (!publisher) throw new CapabilityNotSupportedError(PUBLISH_PORT, target);
      receipts.push(PublishReceipt.parse(await publisher.publish(request, markdownSource)));
    }
    return receipts;
  }
}
