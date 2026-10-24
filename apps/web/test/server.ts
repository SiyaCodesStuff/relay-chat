import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
export const apiOrigin = "http://localhost:5173";
export const testUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "member@example.test",
  displayName: "River",
  role: "user" as const,
};
export const server = setupServer(
  http.get(`${apiOrigin}/api/v1/channels`, () => HttpResponse.json({ channels: [] })),
  http.get(`${apiOrigin}/api/v1/auth/me`, () =>
    HttpResponse.json({ error: "AUTHENTICATION_FAILED" }, { status: 401 }),
  ),
  http.post(`${apiOrigin}/api/v1/auth/login`, () => HttpResponse.json({ user: testUser })),
  http.post(`${apiOrigin}/api/v1/auth/register`, () =>
    HttpResponse.json({ user: testUser }, { status: 201 }),
  ),
  http.post(`${apiOrigin}/api/v1/auth/logout`, () => new HttpResponse(null, { status: 204 })),
);
