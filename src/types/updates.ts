export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
}

export interface UpdateDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}
