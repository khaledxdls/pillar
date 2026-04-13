/**
 * Escape special regex characters in a string so it can be safely
 * interpolated into a RegExp constructor.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate that a resource name is safe to use in regex patterns and shell commands.
 * Pillar resource names must be lowercase alphanumeric with hyphens only.
 * Throws if the name is invalid.
 */
export function assertSafeResourceName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Invalid resource name "${name}". Use lowercase alphanumeric with hyphens (e.g., "user-profile").`,
    );
  }
}
