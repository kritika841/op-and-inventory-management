declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}

interface R2ObjectBody { body: ReadableStream; }
interface R2Bucket {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}
interface Fetcher { fetch(request: Request): Promise<Response>; }
interface DurableObjectId { toString(): string; }
interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectState {
  waitUntil(promise: Promise<unknown>): void;
}
