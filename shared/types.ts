// shared/types.ts
export type Dest = 'archive' | 'keep' | `label:${string}`;
export const NOUL_IDS = ['important','needs_reply','bulk_marketing','newsletter','automated_sender',
  'needs_attention','routine_financial','financial_exception','money_movement','transactional','dev_bot','stale'] as const;
export type NoulId = typeof NOUL_IDS[number];
export interface Email { threadId: string; latestMessageId: string; fromName: string; fromAddress: string;
  subject: string; date: string /*ISO*/; labels: string[]; body: string; unread: boolean }
export interface JevAnswers { destination: { choice: Dest; confidence: number; probabilities: Partial<Record<Dest, number>> };
  nouls: Record<NoulId, number>; failed?: boolean }
export type Outcome = { kind: 'auto_archive' } | { kind: 'proposed'; dest: Dest }
  | { kind: 'queue'; card: 'filing' | 'important'; suggestKeep: boolean };
export interface CardOption { dest: Dest; label: string; p: number }
export interface CardSpec { kind: 'filing' | 'important'; threadId: string; n: number; fromName: string; fromAddress: string;
  subject: string; body: string; why?: string; summary?: string[]; options: CardOption[]; suggestKeep: boolean; gmailUrl: string }
export type DecisionStatus = 'auto_applied' | 'proposed' | 'applied' | 'skipped' | 'failed';
export interface Decision { threadId: string; n: number; subject: string; fromName: string; dest: Dest; who: 'jev' | 'you';
  important: boolean; star: boolean; opened: boolean; status: DecisionStatus; note?: string }
export interface QueueItem { threadId: string; n: number; subject: string; important: boolean }
export type BatchStatus = 'running' | 'reviewing' | 'applying' | 'applied' | 'discarded';
export interface BatchView { sessionId: string; batchId: string; batchNo: number; total: number; read: number;
  /** Candidates whose full fetch from Gmail has finished (fetched, gone or failed). Below `total` while fetching. */ fetched: number;
  status: BatchStatus; paused: boolean; dryRun: boolean; decisions: Decision[]; queue: QueueItem[]; current: CardSpec | null }
export interface Folder { name: string; enabled: boolean; description?: string }
export interface Thresholds { guardNoul: number; importantQueue: number; needsReplyQueue: number;
  autoArchiveConfidence: number; proposeConfidence: number; recentDays: number;
  /** Mail at least this many days old may be archived as stale. */ staleDays: number;
  /** Minimum `stale` answer for the stale rule. */ staleConfidence: number;
  /** Highest `keep` probability at which the junk rule still archives or proposes. */ junkMaxKeep: number }
export interface Settings { query: string; batchSize: 10 | 20 | 30 | 50; folders: Folder[]; thresholds: Thresholds; dryRun: boolean }
export interface SessionSummary { id: string; startedAt: string; batches: number; total: number;
  split: { archived: number; filed: number; you: number; important: number }; unfinishedBatchId?: string;
  /** The session's newest non-discarded batch with emails (else newest non-discarded): what a past-session row opens. */ lastBatchId?: string;
  /** Every applied or auto-applied decision (non-discarded batches) was a dry run: nothing changed Gmail. */ dryRun?: boolean;
  /** Some of those decisions were dry run and some really changed Gmail. */ partlyDryRun?: boolean }
export interface SetupStatus { typesafe: boolean; anthropic: boolean; google: boolean; gmailConnected: boolean;
  foldersChosen: boolean; fake: boolean }
export type SessionEvent =
  | { type: 'snapshot'; view: BatchView }
  | { type: 'decided'; decision: Decision }            // Jev auto/proposed, or a human answer, or a board move
  | { type: 'queued'; item: QueueItem }
  | { type: 'current'; card: CardSpec | null }
  | { type: 'card_text'; threadId: string; why?: string; summary?: string[] }
  | { type: 'progress'; read: number; fetched: number; total: number; paused: boolean }
  | { type: 'status'; status: BatchStatus }
  | { type: 'apply_step'; label: string; count: number; done: boolean }
  | { type: 'error'; message: string };

export const DEFAULT_SETTINGS: Settings = {
  query: 'in:inbox is:unread -category:promotions -category:social',
  batchSize: 20,
  folders: [],
  thresholds: {
    guardNoul: 0.5,
    importantQueue: 0.7,
    needsReplyQueue: 0.7,
    autoArchiveConfidence: 0.85,
    proposeConfidence: 0.6,
    recentDays: 7,
    staleDays: 14,
    staleConfidence: 0.85,
    junkMaxKeep: 0.15,
  },
  dryRun: false,
};
