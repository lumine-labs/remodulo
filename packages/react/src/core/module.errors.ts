import type { ModuleStatus } from "./module-lifecycle.types.js"

// Errors
// ========================================

export const childOfUninitializedParent =
    "Cannot create a child module from an un-initialized parent — its lifecycle is not armed yet, so instances would leak. Init the parent first."

export function childOfDeadParent(status: ModuleStatus): string {
    return `Cannot create a child module under a ${status} parent — that branch is spent, so the child could never be armed. Build it under a live parent, or rebuild the branch first.`
}
