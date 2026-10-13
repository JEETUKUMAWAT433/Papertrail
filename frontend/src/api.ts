export type ClerkTokenGetter = () => Promise<string | null>;

export async function authenticatedFetch(
  path: string,
  getToken: ClerkTokenGetter,
  init?: RequestInit,
): Promise<Response> {
  const token = await getToken();
  if (!token) {
    throw new Error("Your session could not be verified. Please sign in again.");
  }
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
