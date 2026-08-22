import { ValidationError } from "../monitoring/validation";

const MAX_JSON_BYTES = 16 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new ValidationError("The request body is too large.");
  }
  if (!request.body) throw new ValidationError("A JSON request body is required.");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  let finished = false;

  try {
    while (received <= MAX_JSON_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      received += value.byteLength;
      if (received > MAX_JSON_BYTES) {
        throw new ValidationError("The request body is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The connection may already be closed after rejecting the body.
      }
    }
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("The request body must contain valid JSON.");
  }
}
