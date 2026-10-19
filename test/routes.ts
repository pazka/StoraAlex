// The pinned route table (characterization). auth-gate.test.ts asserts that
// buildApp() registers exactly these; boot.test.ts replays them against the
// compiled server. Adding a route means adding it here, on purpose.

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
}

/** Reachable without a session (app.ts needsAuth() allowlist). */
export const PUBLIC_ROUTES: Route[] = [
  { method: 'GET', url: '/healthz' },
  { method: 'GET', url: '/api/setup-needed' },
  { method: 'POST', url: '/api/auth/setup' },
  { method: 'POST', url: '/api/auth/login' },
  { method: 'POST', url: '/api/auth/logout' },
];

/** Every other route: must answer 401 without a valid session. */
export const PROTECTED_ROUTES: Route[] = [
  { method: 'GET', url: '/api/me' },
  // users
  { method: 'GET', url: '/api/users' },
  { method: 'POST', url: '/api/users' },
  { method: 'POST', url: '/api/users/:id/password' },
  { method: 'DELETE', url: '/api/users/:id' },
  // items
  { method: 'GET', url: '/api/items' },
  { method: 'GET', url: '/api/items/:id' },
  { method: 'POST', url: '/api/items' },
  { method: 'PATCH', url: '/api/items/:id' },
  { method: 'POST', url: '/api/items/:id/move' },
  { method: 'POST', url: '/api/items/bulk-move' },
  { method: 'POST', url: '/api/items/:id/tags' },
  { method: 'DELETE', url: '/api/items/:id/tags/:tagId' },
  { method: 'POST', url: '/api/items/:id/archive' },
  { method: 'POST', url: '/api/items/:id/unarchive' },
  { method: 'DELETE', url: '/api/items/:id' },
  { method: 'GET', url: '/api/items/:id/codes' },
  // places
  { method: 'GET', url: '/api/places' },
  { method: 'GET', url: '/api/places/:id' },
  { method: 'POST', url: '/api/places' },
  { method: 'PATCH', url: '/api/places/:id' },
  { method: 'POST', url: '/api/places/:id/move' },
  { method: 'POST', url: '/api/places/:id/tags' },
  { method: 'DELETE', url: '/api/places/:id/tags/:tagId' },
  { method: 'POST', url: '/api/places/:id/archive' },
  { method: 'POST', url: '/api/places/:id/unarchive' },
  { method: 'DELETE', url: '/api/places/:id' },
  { method: 'GET', url: '/api/places/:id/codes' },
  // codes
  { method: 'GET', url: '/api/resolve/:code' },
  { method: 'POST', url: '/api/codes/print' },
  { method: 'POST', url: '/api/codes/assign' },
  // tags, movements
  { method: 'GET', url: '/api/tags' },
  { method: 'POST', url: '/api/tags' },
  { method: 'GET', url: '/api/movements' },
  // media
  { method: 'POST', url: '/api/media' },
  { method: 'GET', url: '/media/:id' },
  // sheet mirror, excel
  { method: 'GET', url: '/api/sheet/status' },
  { method: 'POST', url: '/api/sheet/export' },
  { method: 'GET', url: '/api/export.xlsx' },
  { method: 'POST', url: '/api/import.xlsx' },
];

/** Fill route params with plausible values (the gate runs before validation). */
export function concreteUrl(url: string): string {
  return url.replace(':code', 'OBJ-000001').replace(':tagId', '1').replace(':id', '1');
}
