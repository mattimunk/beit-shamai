/** Admin-area API (session cookie). Types mirror server/ops/*. */
import type { Readiness, Limitation, MarketLevel, Freshness } from "../ops/readiness";
import type { CaseStatus } from "./apiClient";

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any)?.error ?? `HTTP ${r.status}`);
  return j as T;
}

export type Party = "admin" | "user" | "appraiser" | "system";
export interface TaskDto {
  id: string; caseId: string; userId?: string; key: string; party: Party; category: string; priority: number; status: "open" | "done" | "dismissed";
  createdAt: string; updatedAt: string; dueAt?: string; doneAt?: string; doneBy?: string; resolution?: string; note?: string; snoozeUntil?: string;
  assignee?: string; data: any; remindersSent: number; lastReminderAt?: string; remindersPaused: boolean; nextReminderAt?: string;
}
export interface QueueTaskDto extends TaskDto {
  address?: string; appNo?: string; ownerName?: string; ownerEmail?: string; city?: string; service?: string; caseAssignee?: string;
  ageDays: number; overdue: boolean; stale: boolean; effectivePriority: number; blocked?: string; waitingOnUser: boolean;
}
export interface QueueDto { active: QueueTaskDto[]; waiting: QueueTaskDto[]; snoozed: number; doneToday: QueueTaskDto[] }
export interface EventDto { id: number; at: string; caseId?: string; userId?: string; actor?: string; kind: string; data?: any }
export interface Stats {
  users: number; usersToday: number; usersWeek: number; properties: number; drafts: number; newSubmissions: number; attention: number;
  awaitingMarket: number; awaitingDocs: number; readyForPrelim: number; prelimAwaitingApproval: number; prelimDelivered: number;
  fullRequested: number; fullInProgress: number; completed: number; stale: number; remindersDue: number; messagesNotSent: number;
}
export interface OverviewDto {
  stats: Stats; queue: QueueDto; feed: EventDto[]; emailConfigured: boolean; at: string; staleDays: number;
  newUsers: { id: string; name?: string; email: string; role?: string; lang: string; createdAt: string; cases: number }[];
}
export interface PropertyRowDto {
  id: string; appNo?: string; address: string; city?: string; owner?: { id: string; name?: string; email: string }; type?: string; size?: number;
  createdAt: string; submittedAt?: string; updatedAt: string; statusAt?: string; service: "free" | "full"; status: CaseStatus;
  completion: number; confidence: number; level: string; openAdmin: number; openUser: number; topTask?: string; assignee?: string;
  waitingDays: number; stale: boolean; market: Freshness; taskKeys: string[];
}
export interface MessageDto {
  id: string; userId?: string; caseId?: string; kind: string; to: string; lang: string; subject?: string; body?: string; status: string;
  attempts: number; lastError?: string; via?: string; createdAt: string; createdBy?: string; sentAt?: string; nextAttemptAt?: string; taskKeys: string[];
}
export interface NoteDto { id: string; author: string; text: string; at: string }
export interface CityMarketDto { city: string; lastChecked?: string; checkedBy?: string; latestDeal?: string; deals12m: number; dealsTotal: number; freshness: Freshness }
export interface AppraisalDto {
  id: string; status: "draft" | "approved" | "sent" | "superseded"; createdAt: string; createdBy?: string; low: number; point: number; high: number;
  confidence: string; readiness: number; comparables: number; limitations: string[]; evidence: { address: string; date: string; price: number; area: number; distanceM: number }[];
  approvedBy?: string; approvedAt?: string; sentAt?: string; note?: string;
}
export interface FullDto {
  id: string; status: string; purpose: string; purposeNote?: string; quote?: number; payment: string; appraiser?: string;
  checklist: { key: string; done: boolean; by?: string; at?: string }[]; createdAt: string;
}
export type NextAction = "start_review" | "upload_market" | "generate" | "approve" | "send" | "request_info" | "send_quote" | "confirm_payment" | "assign_appraiser" | "deliver" | "full_work" | "close" | "none";
export interface WorkbenchDto {
  case: { id: string; appNo?: string; address: string; status: CaseStatus; service: "free" | "full"; assignee?: string; createdAt: string; updatedAt: string; submittedAt?: string; subject: any; dossier?: any; ownerId?: string };
  owner: { id: string; name?: string; email: string; phone?: string; role?: string; lang: string; createdAt: string; lastSeen?: string; remindersOptOut: boolean } | null;
  readiness: Readiness;
  shots: { done: number; total: number; missing: number };
  market: { city?: CityMarketDto; nearby: number; level: MarketLevel; pendingSearches: number; requestId?: string };
  docs: { id: string; kind: string; fileName: string; mime: string; size: number; addedAt: string; verified: boolean }[];
  tasks: TaskDto[]; appraisals: AppraisalDto[]; full: FullDto | null; messages: MessageDto[]; notes: NoteDto[]; events: EventDto[];
  request: { id: string; status: string; createdAt: string; items: { id: string; city: string; kind: string; from: string; to: string; areaFrom: number; areaTo: number; status: string; note?: string }[] } | null;
  nextAction: NextAction; settings: { reminderDays: number[]; staleDays: number };
}
export interface UserRowDto {
  id: string; name?: string; email: string; phone?: string; role?: string; lang: string; createdAt: string; lastSeen?: string; isAdmin: boolean;
  properties: number; submitted: number; drafts: number; messages: number; lastMessageAt?: string; welcome: string; openRequests: number; remindersOptOut: boolean;
}
export interface UserDetailDto {
  user: UserRowDto; properties: { id: string; appNo?: string; address: string; status: CaseStatus; service: string; updatedAt: string }[];
  tasks: { id: string; key: string; caseId: string; createdAt: string; remindersSent: number; paused: boolean }[];
  messages: MessageDto[]; notes: NoteDto[]; events: EventDto[];
}
export interface SettingsDto {
  freshDays: number; outdatedDays: number; reminderDays: number[]; remindersOn: boolean; staleDays: number; marketRadiusM: number; marketMonths: number; publicUrl: string;
  emailConfigured: boolean; emailVia: string | null; admins: string[];
}
export interface ReportsDto {
  weekStarts: string[]; newUsers: number[]; newProperties: number[]; submittedShare: number; avgDaysToPrelim: number | null; avgDaysTaxWait: number | null;
  remindersSent: number; remindersNotSent: number; docsRequested: number; docsUploadedShare: number; fullEnquiries: number; fullPaid: number; fullDelivered: number;
  prelimDelivered: number; openByCategory: { category: string; party: string; n: number }[];
}

export const adminApi = {
  overview: () => call<OverviewDto>("/api/admin/overview"),
  properties: () => call<PropertyRowDto[]>("/api/admin/properties"),
  property: (id: string) => call<WorkbenchDto>(`/api/admin/properties/${encodeURIComponent(id)}`),
  propertyAction: (id: string, what: "status" | "assign" | "appraisal" | "full" | "message" | "notes" | "market" | "sync", body: unknown) =>
    call<WorkbenchDto>(`/api/admin/properties/${encodeURIComponent(id)}/${what}`, "POST", body),
  task: (id: string, body: { action: string; reason?: string; until?: string; assignee?: string; note?: string; subject?: string; text?: string }) =>
    call<TaskDto>(`/api/admin/tasks/${encodeURIComponent(id)}`, "POST", body),
  reminderPreview: (id: string) => call<{ to: string; lang: string; subject: string; text: string }>(`/api/admin/tasks/${encodeURIComponent(id)}/reminder`),
  users: () => call<UserRowDto[]>("/api/admin/users"),
  user: (id: string) => call<UserDetailDto>(`/api/admin/users/${encodeURIComponent(id)}`),
  userAction: (id: string, what: "welcome" | "message" | "notes" | "reminders", body: unknown = {}) => call<UserDetailDto>(`/api/admin/users/${encodeURIComponent(id)}/${what}`, "POST", body),
  settings: () => call<SettingsDto>("/api/admin/settings"),
  saveSettings: (s: Partial<SettingsDto>) => call<SettingsDto>("/api/admin/settings", "PUT", s),
  reports: () => call<ReportsDto>("/api/admin/reports"),
  retryMessage: (id: string) => call<MessageDto>(`/api/admin/messages/${encodeURIComponent(id)}/retry`, "POST", {}),
  retryUnsent: () => call<{ queued: number }>("/api/admin/messages/retry-unsent", "POST", {}),
  tick: () => call<unknown>("/api/admin/tick", "POST", {}),
};

// ---- Applicant ---------------------------------------------------------------------------------

export interface MyAppraisalDto {
  preliminary: { low: number; point: number; high: number; confidence: string; readiness: number; comparables: number; limitations: string[]; sentAt?: string } | null;
  full: { status: string; purpose: string; quote?: number; createdAt: string } | null;
}
export const myAppraisal = (caseId: string) => call<MyAppraisalDto>(`/api/cases/${encodeURIComponent(caseId)}/appraisal`);
export const requestFullAppraisal = (caseId: string, purpose: string, note?: string) => call<{ full: FullDto }>(`/api/cases/${encodeURIComponent(caseId)}/full`, "POST", { purpose, note });
export const acceptQuote = (caseId: string) => call<{ full: FullDto }>(`/api/cases/${encodeURIComponent(caseId)}/full`, "POST", { accept: true });

export type { Limitation };
