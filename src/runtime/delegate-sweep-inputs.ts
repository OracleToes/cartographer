/** Dormant source-checkpoint identity inspection for a prospective return sweep. */
import { isDeepStrictEqual } from "node:util";
import { InboxDoc, ROOT_CONVERSATION_ID, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { DelegateChildIdentityDoc } from "./delegate-conversation.js";
import { ownedHandoff } from "./delegate-control.js";
import { DelegateInputCheckpointDoc, parseInputCheckpoint } from "./delegate-inputs.js";
import { DelegateMainBarrierDoc, DelegationDoc } from "./delegation-record.js";
import type { ReturnSweepView } from "./delegate-sweep-view.js";

export type ReturnSweepInput = {
  submissionId: number;
  conversationId: number;
  placement: "placed" | "queued";
  status: "queued" | "placed" | "done" | "unanswered";
  entryId: number | null;
  active: boolean;
  /** False after Pi removed a queued inbox item: only the checkpoint retains its content. */
  contentVerified: boolean;
};

/**
 * Inspect a source checkpoint on Pi's transaction line after capturing actual
 * views with captureReturnSweepViews. The caller must seal admissions,
 * withdrawals, context writes and work, and keep them sealed through source
 * handling. Bounds checks are not a lock and this does not reconstruct Pi's
 * private context derivation. A queued input withdrawn by abort has no retained
 * content to independently verify; the checkpoint is its only remaining copy.
 * A placed input may already be marked done by Pi; that status is reported,
 * not interpreted as proof that its delegation was fully answered. No archive,
 * replay, transfer or deletion is performed by this inspection.
 */
export async function inspectReturnSweepInputs(
  tx: Tx, mainId: ConversationId, id: string, views: readonly ReturnSweepView[],
): Promise<ReturnSweepInput[]> {
  if (mainId !== ROOT_CONVERSATION_ID) throw new Error("Return input inspection requires main; the source was preserved.");
  const active = (await tx.doc(DelegationDoc, mainId)).active;
  const barrier = await tx.doc(DelegateMainBarrierDoc, mainId);
  if (active?.phase !== "returned" || active.input.id !== id || barrier.sourceId !== id ||
      barrier.admittedId !== null || barrier.submissionId !== null) {
    throw new Error("Return input inspection requires the matching source handoff and barrier; the source was preserved.");
  }
  const owned = await ownedHandoff(tx, mainId, active);
  if (owned.childId !== null) {
    const identity = await tx.doc(DelegateChildIdentityDoc, owned.childId);
    if (Object.keys(identity).length !== 3 || identity.mainId !== mainId || identity.ownerId !== owned.ownerId || identity.handoffId !== id) {
      throw new Error("Return input child identity conflicts with the handoff; the source was preserved.");
    }
  }
  const saved = parseInputCheckpoint(JSON.stringify(await tx.doc(DelegateInputCheckpointDoc, mainId)), id);
  const byConversation = new Map<number, ReturnSweepView>();
  for (const view of views) {
    const conversation = await tx.conversation(view.conversation.id);
    const tail = await tx.latestEntryId(view.conversation.id);
    const head = (await tx.latestHeadMarker(view.conversation.id))?.id;
    if (byConversation.has(view.conversation.id) || !isDeepStrictEqual(conversation, view.conversation) ||
        tail !== view.tail || head !== view.view.head?.id || view.view.entries.length !== view.view.contributions.length ||
        view.view.entries.some((entry) => entry.conversationId !== view.conversation.id)) {
      throw new Error("Return input view bounds or identity changed; the source was preserved.");
    }
    byConversation.set(view.conversation.id, view);
  }
  if (!byConversation.has(mainId) || (owned.childId !== null && !byConversation.has(owned.childId))) {
    throw new Error("Return input view is missing an owned conversation; the source was preserved.");
  }
  const result: ReturnSweepInput[] = [];
  const placedEntries = new Set<number>();
  for (const input of saved.inputs) {
    const submission = await tx.submission(input.submissionId as SubmissionId);
    if (submission?.type !== "input" || (submission.conversationId !== mainId && submission.conversationId !== owned.childId)) {
      throw new Error("A checkpoint submission is missing or belongs to another conversation; the source was preserved.");
    }
    if (submission.requestId === `carto.delegate-input:${owned.ownerId}`) {
      throw new Error("The delegate's initial instruction is not a checkpointed person input; the source was preserved.");
    }
    if (input.placement === "queued") {
      if (submission.entry !== undefined || (submission.status !== "queued" && submission.status !== "unanswered")) {
        throw new Error("A queued checkpoint input was placed or changed; the source was preserved.");
      }
      const inbox = await tx.doc(InboxDoc, submission.conversationId);
      const items = inbox.items.filter((item) => item.id === submission.id);
      if (submission.status === "queued") {
        const item = items[0];
        const draft = item?.entry === undefined ? { kind: "pi.user" } : { kind: item.entry.kind, ...(item.entry.data === undefined ? {} : { data: item.entry.data }) };
        if (items.length !== 1 || item === undefined || item.mode === "write" || item.mode !== input.whenBusy ||
            !isDeepStrictEqual(item.content, input.content) || !isDeepStrictEqual(draft, input.entry)) {
          throw new Error("A queued input conflicts with its checkpoint; the source was preserved.");
        }
      } else if (items.length !== 0) {
        throw new Error("A withdrawn input remains in the inbox; the source was preserved.");
      }
      result.push({ submissionId: submission.id, conversationId: submission.conversationId, placement: "queued", status: submission.status,
        entryId: null, active: false, contentVerified: submission.status === "queued" });
      continue;
    }
    if (submission.status === "queued" || submission.entry === undefined || placedEntries.has(submission.entry)) {
      throw new Error("A placed checkpoint input lacks a unique source entry; the source was preserved.");
    }
    placedEntries.add(submission.entry);
    const entry = await tx.entry(submission.entry);
    const message = entry?.model?.[0];
    if (entry?.conversationId !== submission.conversationId || entry.kind !== input.entry.kind ||
        !isDeepStrictEqual(entry.data, input.entry.data) || entry.model?.length !== 1 || message?.role !== "user" ||
        !isDeepStrictEqual(message.content, input.content)) {
      throw new Error("A placed input conflicts with its checkpoint; the source was preserved.");
    }
    const view = byConversation.get(submission.conversationId)!.view;
    const index = view.entries.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
      const contribution = view.contributions[index];
      if (!isDeepStrictEqual(view.entries[index], entry) || contribution?.length !== 1 || contribution[0]?.role !== "user" ||
          !isDeepStrictEqual(contribution[0].content, input.content)) {
        throw new Error("An active checkpoint input was edited or changed; the source was preserved.");
      }
    }
    result.push({ submissionId: submission.id, conversationId: submission.conversationId, placement: "placed", status: submission.status,
      entryId: entry.id, active: index >= 0, contentVerified: true });
  }
  return result;
}
