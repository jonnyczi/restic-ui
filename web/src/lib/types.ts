// API data shapes, mirrored from the Go structs.

export type BackendType = "local" | "s3" | "sftp" | "rclone";

export interface RepoConfig {
  path?: string;
  endpoint?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  useHttp?: boolean;
  host?: string;
  port?: number;
  user?: string;
  remote?: string;
}

export interface RepoSecrets {
  secretAccessKey?: string;
  privateKey?: string;
  rcloneConf?: string;
}

export interface Repo {
  id: number;
  name: string;
  backendType: BackendType;
  config: RepoConfig;
  hasSecrets: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepoInput {
  name: string;
  backendType: BackendType;
  config: RepoConfig;
  password: string;
  secrets: RepoSecrets;
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  username: string;
  paths: string[];
  tags?: string[];
  summary?: {
    total_files_processed: number;
    total_bytes_processed: number;
  };
}

export interface RepoStats {
  total_size: number;
  total_file_count: number;
  snapshots_count: number;
}

export interface Retention {
  keepLast?: number;
  keepHourly?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepYearly?: number;
  prune?: boolean;
}

export interface Plan {
  id: number;
  name: string;
  repoId: number;
  repoName: string;
  sources: string[];
  excludes: string[];
  tags: string[];
  scheduleCron: string;
  retention: Retention;
  enabled: boolean;
  notifyMuted: boolean;
  nextRun?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  name: string;
  repoId: number;
  sources: string[];
  excludes: string[];
  tags: string[];
  scheduleCron: string;
  retention: Retention;
  enabled: boolean;
  notifyMuted: boolean;
}

export interface ForgetSnapshot {
  id: string;
  short_id: string;
  time: string;
  paths: string[];
}

export interface ForgetGroup {
  host: string;
  paths: string[];
  tags: string[] | null;
  keep: ForgetSnapshot[];
  remove: ForgetSnapshot[];
}

export interface LsNode {
  name: string;
  type: string; // file | dir | symlink
  path: string;
  size: number;
  mtime: string;
}

export interface NotifySettings {
  appriseApiUrl: string;
  appriseUrls: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

export interface DashboardPlan {
  id: number;
  name: string;
  repoName: string;
  scheduleCron: string;
  enabled: boolean;
  nextRun?: string;
  lastStatus?: OpStatus;
  lastRun?: string;
  overdue: boolean;
}

export interface RepoStatsPoint {
  capturedAt: string;
  totalSize: number;
  totalFileCount: number;
  snapshotsCount: number;
}

export interface RepoGrowth {
  repoId: number;
  repoName: string;
  points: { t: string; size: number }[];
}

export interface Dashboard {
  repoCount: number;
  planCount: number;
  runningOps: number;
  issues24h: number;
  plans: DashboardPlan[];
  recentOps: Operation[];
  repoGrowth: RepoGrowth[];
  planDurations: Record<number, { t: string; seconds: number }[]>;
}

export type OpStatus = "queued" | "running" | "success" | "warning" | "error" | "canceled";

export interface Operation {
  id: number;
  type: string;
  repoId?: number;
  repoName?: string;
  planId?: number;
  planName?: string;
  status: OpStatus;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  summary?: {
    snapshot_id?: string;
    files_new?: number;
    files_changed?: number;
    files_unmodified?: number;
    data_added?: number;
    total_duration?: number;
  };
  createdAt: string;
}

export interface LogLine {
  seq: number;
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface OpProgress {
  percentDone: number;
  totalFiles: number;
  filesDone: number;
  totalBytes: number;
  bytesDone: number;
  secondsLeft: number;
  currentFile?: string;
}

export interface StreamEvent {
  type: "op" | "log" | "progress";
  op?: Operation;
  opId?: number;
  log?: LogLine;
  progress?: OpProgress;
}

export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListing {
  path: string;
  parent?: string;
  entries: FsEntry[];
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Compact locale timestamp for table cells, e.g. "7/12/26, 3:04 PM". */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
