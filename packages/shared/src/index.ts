export type Result<T> = {
  ok: boolean;
  value?: T;
  error?: Error;
};

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
