import type { ImmutableObject } from "./immutable-object";
import { freezeOutboxBytes, type ImmutableOutboxEntry } from "./outbox";
import type { PublishEnvelope } from "./remote-publish";

export interface FrozenPublishPlan {
  envelope: PublishEnvelope;
  outboxCommit: ImmutableOutboxEntry;
}

export function freezePublishPlan(envelope: PublishEnvelope): FrozenPublishPlan {
  return {
    envelope: {
      blobs: copyObjects(envelope.blobs),
      configTrees: copyObjects(envelope.configTrees),
      chunks: copyObjects(envelope.chunks),
      commit: copyObject(envelope.commit),
    },
    outboxCommit: freezeOutboxBytes(envelope.commit.key, envelope.commit.bytes),
  };
}

function copyObjects(objects: readonly ImmutableObject[]): ImmutableObject[] { return objects.map(copyObject); }
function copyObject(object: ImmutableObject): ImmutableObject { return { ...object, bytes: new Uint8Array(object.bytes) }; }
