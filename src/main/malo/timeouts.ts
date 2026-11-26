import { DemoError } from "../../shared/errors";

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DemoError("E_CDP_ATTACH_FAILED", message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
