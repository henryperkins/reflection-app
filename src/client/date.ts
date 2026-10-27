export function date(value: string, dateOnly = false): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    ...(dateOnly ? {} : { timeStyle: 'short' }),
  });
}
