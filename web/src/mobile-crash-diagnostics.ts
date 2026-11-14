export interface MobileCrashReportSummary {
  id: string;
  kind: "crash" | "snapshot";
  capturedAt: string;
  appBuild: string;
  signal?: number;
  appBinaryUUID?: string;
  bundleIdentifier?: string;
}

export interface MobileCrashReportStatus {
  enabled: boolean;
  storage: string;
  reports: MobileCrashReportSummary[];
  error?: string;
}
