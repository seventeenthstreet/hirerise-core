export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | Record<string, boolean | undefined | null>;

/**
 * Lightweight className utility.
 *
 * Supports:
 * - strings
 * - numbers
 * - nested arrays
 * - conditional object syntax
 *
 * Example:
 * cn(
 *   'btn',
 *   isActive && 'btn-active',
 *   ['px-4', ['py-2']],
 *   { disabled: isDisabled }
 * )
 */
export function cn(...inputs: ClassValue[]): string {
  const classes: string[] = [];

  const process = (value: ClassValue): void => {
    if (!value) return;

    if (typeof value === 'string' || typeof value === 'number') {
      classes.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        process(item);
      }
      return;
    }

    if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) {
          classes.push(key);
        }
      }
    }
  };

  for (const input of inputs) {
    process(input);
  }

  return classes.join(' ');
}