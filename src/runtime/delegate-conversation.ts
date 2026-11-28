/**
 * Dormant building block for a focused, task-owned Pi conversation. This does
 * not submit an instruction or expose a delegation tool. The caller must own
 * the handoff lifecycle and keep orchestration disabled until its controls and
 * recovery are implemented.
 */
import { AgentDoc, configure, defineDoc, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, type ConversationHandle, type ConversationId, type Extension, type ModelRef, type SubmissionId, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { DelegationDoc, startDelegation } from "./delegation-record.js";

/** The same Pi request identity is used for admission, retry and recovery scans. */
export const delegateInputRequestId = (ownerId: TaskId): string => `carto.delegate-input:${ownerId}`;

/** Durable link checked by the child request barrier; not a substitute for task ownership. */
export const DelegateChildIdentityDoc = defineDoc<{ mainId: number | null; ownerId: number | null; handoffId: string | null }>({
  kind: "carto.delegate-child-identity", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ mainId: null, ownerId: null, handoffId: null }), checkpointWhen: () => true,
});

type RestoreOrigin = { generation: string; conversationId: number };
type RestoreRoute = RestoreOrigin & { destinationId: number };

/** A destination generation's durable mapping of archived child contexts. */
export const DelegateRestoreRoutesDoc = defineDoc<{ routes: RestoreRoute[] }>({
  kind: "carto.delegate-restore-routes", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ routes: [] }), checkpointWhen: () => true,
});

/** A passive destination is not the original running delegate or its task. */
export const DelegateRestoreOriginDoc = defineDoc<{ generation: string | null; conversationId: number | null }>({
  kind: "carto.delegate-restore-origin", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ generation: null, conversationId: null }), checkpointWhen: () => true,
});

function validRestoreOrigin(origin: RestoreOrigin): boolean {
  return typeof origin.generation === "string" && /^gen-[\w-]+$/.test(origin.generation) &&
    Number.isSafeInteger(origin.conversationId) && origin.conversationId > ROOT_CONVERSATION_ID;
}

async function restoreRoutes(tx: Tx): Promise<RestoreRoute[]> {
  const doc = await tx.doc(DelegateRestoreRoutesDoc, ROOT_CONVERSATION_ID);
  if (Object.keys(doc).length !== 1 || !Array.isArray(doc.routes)) throw new Error("Invalid delegate restore routes; archive data was preserved.");
  const origins = new Set<string>();
  const destinations = new Set<number>();
  for (const route of doc.routes) {
    if (route === null || typeof route !== "object" || Object.keys(route).length !== 3 || !validRestoreOrigin(route) ||
        !Number.isSafeInteger(route.destinationId) || route.destinationId <= ROOT_CONVERSATION_ID ||
        origins.has(JSON.stringify([route.generation, route.conversationId])) || destinations.has(route.destinationId)) {
      throw new Error("Ambiguous delegate restore routes; archive data was preserved.");
    }
    origins.add(JSON.stringify([route.generation, route.conversationId]));
    destinations.add(route.destinationId);
  }
  return doc.routes;
}

/** Verify the route, passive Pi destination and idle inbox on the transaction line. */
export async function requireDelegateRestoreDestination(tx: Tx, origin: RestoreOrigin, destination: ConversationId): Promise<void> {
  if (!validRestoreOrigin(origin)) throw new Error("Invalid delegate restore origin; archive data was preserved.");
  const routes = await restoreRoutes(tx);
  const route = routes.find((candidate) => candidate.generation === origin.generation && candidate.conversationId === origin.conversationId);
  const mainLive = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  const mainInbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
  const record = await tx.conversation(destination);
  const marker = await tx.doc(DelegateRestoreOriginDoc, destination);
  const agent = await tx.doc(AgentDoc, destination);
  const live = await tx.doc(LiveDoc, destination);
  const inbox = await tx.doc(InboxDoc, destination);
  if (route?.destinationId !== destination || record === undefined || record.parent !== undefined || record.owner !== undefined ||
      Object.keys(marker).length !== 2 || marker.generation !== origin.generation || marker.conversationId !== origin.conversationId ||
      Object.keys(agent).length !== 4 || agent.model !== undefined || !Array.isArray(agent.extensions) || agent.extensions.length !== 0 ||
      !Array.isArray(agent.tools) || agent.tools.length !== 0 || !Array.isArray(agent.modelTools) || agent.modelTools.length !== 0 ||
      agent.compaction?.enabled !== false || Object.keys(agent.compaction).length !== 1 ||
      mainLive.run !== undefined || mainInbox.items.length !== 0 || live.run !== undefined || inbox.items.length !== 0) {
    throw new Error("Delegate restore destination conflicts or is busy; archive data was preserved.");
  }
}

/**
 * Create or reuse an isolated, ownerless passive context, never main. This is
 * an archival destination, not a resumed delegate or a scheduler. The caller
 * must seal admissions and all context writers through placement and Brain
 * acknowledgement; Pi's transaction protects only this mapping and creation.
 */
export async function ensureDelegateRestoreDestination(tx: Tx, origin: RestoreOrigin): Promise<ConversationId> {
  if (!validRestoreOrigin(origin) || await tx.conversation(ROOT_CONVERSATION_ID) === undefined) {
    throw new Error("Invalid delegate restore origin or missing main; archive data was preserved.");
  }
  const mainLive = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
  const mainInbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
  if (mainLive.run !== undefined || mainInbox.items.length !== 0) throw new Error("Main is busy; archive data was preserved.");
  const routes = await restoreRoutes(tx);
  const route = routes.find((candidate) => candidate.generation === origin.generation && candidate.conversationId === origin.conversationId);
  if (route !== undefined) {
    await requireDelegateRestoreDestination(tx, origin, route.destinationId as ConversationId);
    return route.destinationId as ConversationId;
  }
  const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await configure(tx, child.id, { model: null, extensions: [], tools: [], modelTools: [], compaction: { enabled: false } });
  const marker = await tx.doc(DelegateRestoreOriginDoc, child.id);
  marker.generation = origin.generation;
  marker.conversationId = origin.conversationId;
  routes.push({ ...origin, destinationId: child.id });
  return child.id;
}

async function identifyChild(tx: Tx, child: ConversationId, main: ConversationId, owner: TaskId, handoff: string): Promise<void> {
  const identity = await tx.doc(DelegateChildIdentityDoc, child);
  if (identity.mainId === null && identity.ownerId === null && identity.handoffId === null && Object.keys(identity).length === 3) {
    identity.mainId = main;
    identity.ownerId = owner;
    identity.handoffId = handoff;
  } else if (Object.keys(identity).length !== 3 || identity.mainId !== main || identity.ownerId !== owner || identity.handoffId !== handoff) {
    throw new Error("Delegate child identity conflicts with its owner; it was preserved.");
  }
}

/** Call in the owning task's commit; no model or filesystem work runs here. */
export async function ensureDelegateConversation(
  tx: Tx,
  mainId: ConversationId,
  ownerId: TaskId,
  delegationId: string,
  agent: { model: ModelRef; cwd: string; instructions: string; extensions?: readonly Extension[]; tools?: readonly ToolRegistration[] },
): Promise<ConversationId> {
  if (!agent.model.provider.trim() || !agent.model.modelId.trim() || !agent.cwd.trim() || !agent.instructions.trim()) {
    throw new Error("A delegate requires an explicit model, working directory and instructions.");
  }
  // Table reads must precede createConversation: Pi rejects reads after writes.
  const owner = await tx.task(ownerId);
  const children = (await tx.scanConversations({ ownerTaskId: ownerId }, 2)).items;
  if (owner === undefined || owner.conversationId !== mainId) throw new Error("Delegate owner does not belong to the main conversation.");
  const record = await tx.doc(DelegationDoc, mainId);
  const active = record.active;
  if (active === null || active.input.id !== delegationId || active.phase === "ending" ||
      (active.phase === "returned" && active.result.kind !== "delegate")) {
    throw new Error("Delegation is not available for this owner.");
  }
  if (active.phase === "running" || active.phase === "returned") {
    if (children.length !== 1 || children[0]?.id !== active.conversationId || children[0].owner?.conversationId !== mainId) {
      throw new Error("Delegate conversation ownership conflicts with the handoff; data was preserved.");
    }
    await identifyChild(tx, children[0].id, mainId, ownerId, delegationId);
    return children[0].id;
  }
  if (children.length !== 0) throw new Error("Unexpected delegate conversations for the owner; data was preserved.");
  const child = await tx.createConversation({ ownership: { kind: "task", taskId: ownerId } });
  // Task-owned conversations inherit the owner's agent by default. Explicitly
  // replace inherited selections and prompt; a delegate must not inherit main's
  // tools, extensions, context, or automatic compaction. The caller selects
  // every extension and tool explicitly.
  await configure(tx, child.id, {
    model: agent.model,
    cwd: agent.cwd,
    instructions: agent.instructions,
    extensions: agent.extensions ?? [],
    tools: agent.tools ?? [],
    modelTools: agent.tools ?? [],
    compaction: { enabled: false },
  });
  await identifyChild(tx, child.id, mainId, ownerId, delegationId);
  startDelegation(record, delegationId, child.id);
  return child.id;
}

/** Admit the first child input only while its own handoff is still running. */
export async function admitDelegateInput(
  tx: Tx,
  mainId: ConversationId,
  ownerId: TaskId,
  delegationId: string,
  child: ConversationHandle,
): Promise<SubmissionId | null> {
  const conversation = await tx.conversation(child.id);
  const record = await tx.doc(DelegationDoc, mainId);
  const active = record.active;
  if (active === null || active.input.id !== delegationId || active.phase === "prepared" ||
      active.conversationId !== child.id || conversation?.owner?.conversationId !== mainId ||
      conversation.owner.taskId !== ownerId) {
    throw new Error("Delegate input does not match its owned handoff; no input was admitted.");
  }
  if (active.phase === "returned" || active.phase === "ending") return null;
  return child.submit(tx, {
    type: "input", content: JSON.stringify(active.input), requestId: delegateInputRequestId(ownerId),
  });
}
