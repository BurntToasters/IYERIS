export interface ClipboardOperation {
  operation: 'copy' | 'cut';
  paths: string[];
}
