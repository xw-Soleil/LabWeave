export type SnapshotReason = "manual" | "auto" | "report";

export interface ResearchSnapshotFile {
  path: string;
  hash: string;
  contentHash?: string;
  size: number;
  kind: "workspace" | "markdown" | "pdf" | "image" | "annotations" | "other";
}

export interface ResearchSnapshot {
  version: 1;
  id: string;
  projectId: string;
  createdAt: string;
  weekStart: string;
  reason: SnapshotReason;
  files: ResearchSnapshotFile[];
  warnings: string[];
}

export interface SnapshotChange {
  path: string;
  kind: "added" | "removed" | "modified" | "moved" | "layout";
  previousPath?: string;
  before?: string;
  after?: string;
}

export interface SnapshotDiff {
  beforeId: string;
  afterId: string;
  changes: SnapshotChange[];
  warnings: string[];
}

export interface ReportProgress {
  stage: "collecting" | "analyzing" | "exporting";
  message?: string;
}

export interface ResearchReportResult {
  jobId?: string;
  directory: string;
  markdownPath: string;
  pptxPath: string;
  snapshotId: string;
  warnings: string[];
}

export interface GenerateResearchReportOptions {
  root: string;
  snapshotId: string;
  baselineId?: string;
  instructions?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ReportProgress) => void;
}
