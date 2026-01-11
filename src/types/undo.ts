export interface UndoCreateAction {
  type: 'create';
  data: { path: string; isDirectory: boolean };
}

export interface UndoRenameAction {
  type: 'rename';
  data: { oldPath: string; newPath: string; oldName: string; newName: string };
}

export interface UndoMoveAction {
  type: 'move';
  data: { sourcePaths: string[]; originalPaths?: string[]; originalParent?: string; destPath: string };
}

export interface UndoTrashAction {
  type: 'trash';
  data: { path: string; originalPath?: string };
}

export type UndoAction = UndoCreateAction | UndoRenameAction | UndoMoveAction | UndoTrashAction;
