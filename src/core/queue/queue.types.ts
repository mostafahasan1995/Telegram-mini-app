/**
 * WHY: `queue.add('ichancy.credit', { depositId })` compiles even when the processor expects
 * `depositRequestId`, and the mistake only surfaces as a job that fails forever in production. The
 * map below pairs every task name with its payload AND its queue, so both are checked at compile
 * time and a new task cannot be added without declaring where it runs (the mapped type over
 * `TaskName` in TASK_QUEUE makes omission a type error).
 *
 * PAYLOAD RULE: a job payload is JSON on the wire. Money therefore travels as a DECIMAL STRING of
 * minor units (`"1234"` = 12.34 NSP) and is turned back into bigint by the processor. Never put a
 * `bigint` in a payload type — it would silently become a string anyway and the processor's type
 * would be a lie.
 */
import { QUEUE_NAMES, type QueueName } from './queue.constants';
import type { JsonObject } from './json.util';

/** Decimal string of bigint minor units, e.g. "1234" for 12.34 NSP. Decode with `BigInt(value)`. */
export type MinorString = string;

export const TASKS = {
  /** The only task the relay produces: one committed outbox row, ready to be acted on. */
  OUTBOX_DISPATCH: 'outbox.dispatch',

  /** Credit an approved deposit into a player's Ichancy wallet (balance-delta verified). */
  ICHANCY_DEPOSIT_CREDIT: 'ichancy.deposit.credit',
  /** registerPlayer + resolve the real playerId through getPlayersForCurrentAgent. */
  ICHANCY_PLAYER_REGISTER: 'ichancy.player.register',
  /** Re-read getAgentAllWallets and post an AGENT_FLOAT_SYNC correction if it drifted. */
  ICHANCY_AGENT_FLOAT_SYNC: 'ichancy.agentFloat.sync',

  /** Post the admin review card for a submitted deposit. */
  TELEGRAM_ADMIN_CARD_POST: 'telegram.admin.card.post',
  /** Edit an existing review card in place after a state change. */
  TELEGRAM_ADMIN_CARD_UPDATE: 'telegram.admin.card.update',
  /** Notify a player in their private chat. */
  TELEGRAM_NOTIFY_PLAYER: 'telegram.notify.player',

  /** Download/normalize/hash a deposit proof image. */
  MEDIA_PROOF_PROCESS: 'media.proof.process',

  /** Compare ICHANCY_AGENT_FLOAT against getAgentAllWallets. */
  RECON_AGENT_FLOAT_CHECK: 'recon.agentFloat.check',
  /** Find deposits parked in a non-terminal state past their SLA. */
  RECON_STUCK_DEPOSITS: 'recon.stuckDeposits.check',
  /** Re-verify a single deposit whose credit outcome was ambiguous. */
  RECON_DEPOSIT_VERIFY: 'recon.deposit.verify',
} as const;

export interface OutboxDispatchTask {
  outboxId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonObject;
  /** Relay-side publish attempt. Not the BullMQ attempt counter. */
  attempt: number;
}

export interface IchancyDepositCreditTask {
  depositRequestId: string;
  /** Also the Ichancy `comment`, i.e. the only breadcrumb a human can find in their panel. */
  shortId: string;
  /** Part of the per-player mutex key: a stale worker holding an old epoch must not credit. */
  creditKeyEpoch: number;
  amountMinor: MinorString;
}

export interface IchancyPlayerRegisterTask {
  playerId: string;
}

export interface IchancyAgentFloatSyncTask {
  reason: 'CRON' | 'MANUAL' | 'LOW_WATERMARK' | 'AFTER_CREDIT';
}

export interface TelegramAdminCardPostTask {
  depositRequestId: string;
}

export interface TelegramAdminCardUpdateTask {
  depositRequestId: string;
  /** Why the card is being redrawn; ends up in the audit trail, not on screen. */
  reason: string;
}

export interface TelegramNotifyPlayerTask {
  playerId: string;
  /** Stable template key, resolved to text by the telegram module. Never a rendered sentence. */
  template: string;
  params: JsonObject;
}

export interface MediaProofProcessTask {
  depositProofId: string;
}

export interface ReconAgentFloatCheckTask {
  currencyCode: string;
}

export interface ReconStuckDepositsTask {
  olderThanMinutes: number;
}

export interface ReconDepositVerifyTask {
  depositRequestId: string;
  /** Balance we read before the ambiguous call; the delta is measured against this. */
  balanceBeforeMinor: MinorString;
  expectedDeltaMinor: MinorString;
}

/** The single source of truth: task name -> payload shape. */
export interface TaskMap {
  [TASKS.OUTBOX_DISPATCH]: OutboxDispatchTask;
  [TASKS.ICHANCY_DEPOSIT_CREDIT]: IchancyDepositCreditTask;
  [TASKS.ICHANCY_PLAYER_REGISTER]: IchancyPlayerRegisterTask;
  [TASKS.ICHANCY_AGENT_FLOAT_SYNC]: IchancyAgentFloatSyncTask;
  [TASKS.TELEGRAM_ADMIN_CARD_POST]: TelegramAdminCardPostTask;
  [TASKS.TELEGRAM_ADMIN_CARD_UPDATE]: TelegramAdminCardUpdateTask;
  [TASKS.TELEGRAM_NOTIFY_PLAYER]: TelegramNotifyPlayerTask;
  [TASKS.MEDIA_PROOF_PROCESS]: MediaProofProcessTask;
  [TASKS.RECON_AGENT_FLOAT_CHECK]: ReconAgentFloatCheckTask;
  [TASKS.RECON_STUCK_DEPOSITS]: ReconStuckDepositsTask;
  [TASKS.RECON_DEPOSIT_VERIFY]: ReconDepositVerifyTask;
}

export type TaskName = keyof TaskMap;
export type TaskPayload<N extends TaskName> = TaskMap[N];
/** Union of every payload — the data type the underlying BullMQ Queue is parameterised with. */
export type AnyTaskPayload = TaskMap[TaskName];

/**
 * Which queue each task runs on. The mapped type is deliberate: adding a member to TaskMap without
 * adding it here is a compile error, so a task can never be enqueued onto a queue nobody drains.
 */
export const TASK_QUEUE: { readonly [N in TaskName]: QueueName } = Object.freeze({
  [TASKS.OUTBOX_DISPATCH]: QUEUE_NAMES.OUTBOX,
  [TASKS.ICHANCY_DEPOSIT_CREDIT]: QUEUE_NAMES.ICHANCY,
  [TASKS.ICHANCY_PLAYER_REGISTER]: QUEUE_NAMES.ICHANCY,
  [TASKS.ICHANCY_AGENT_FLOAT_SYNC]: QUEUE_NAMES.ICHANCY,
  [TASKS.TELEGRAM_ADMIN_CARD_POST]: QUEUE_NAMES.TELEGRAM,
  [TASKS.TELEGRAM_ADMIN_CARD_UPDATE]: QUEUE_NAMES.TELEGRAM,
  [TASKS.TELEGRAM_NOTIFY_PLAYER]: QUEUE_NAMES.TELEGRAM,
  [TASKS.MEDIA_PROOF_PROCESS]: QUEUE_NAMES.MEDIA,
  [TASKS.RECON_AGENT_FLOAT_CHECK]: QUEUE_NAMES.RECON,
  [TASKS.RECON_STUCK_DEPOSITS]: QUEUE_NAMES.RECON,
  [TASKS.RECON_DEPOSIT_VERIFY]: QUEUE_NAMES.RECON,
});

export const ALL_TASK_NAMES: readonly TaskName[] = Object.freeze(
  Object.keys(TASK_QUEUE) as TaskName[],
);
