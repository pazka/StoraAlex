import { describe, it, expect } from 'vitest';
import type { InjectOptions } from 'fastify';
import { makeApp, loginCookie, TEST_USER } from './helpers.ts';

describe('first-run setup', () => {
  it('reports setup needed, creates the first user, then closes setup', async () => {
    const { app } = await makeApp({ seed: false });

    expect((await app.inject({ method: 'GET', url: '/api/setup-needed' })).json().needed).toBe(true);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'first', password: 'longenough1' },
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.json().user.username).toBe('first');

    // The session cookie was set — it reaches a protected route.
    const sid = setup.cookies.find((c) => c.name.endsWith('storalex_sid'))!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${sid.name}=${sid.value}` } });
    expect(me.json().user.username).toBe('first');

    // Setup is now closed.
    expect((await app.inject({ method: 'GET', url: '/api/setup-needed' })).json().needed).toBe(false);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'second', password: 'longenough1' },
    });
    expect(second.statusCode).toBe(403);

    await app.close();
  });

  it('refuses setup when a user already exists', async () => {
    const { app } = await makeApp(); // seeds tester
    expect((await app.inject({ method: 'GET', url: '/api/setup-needed' })).json().needed).toBe(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'x', password: 'longenough1' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('user management (any authenticated user)', () => {
  it('creates, lists, logs in as, re-passwords, and deletes users', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const authed = (o: InjectOptions): InjectOptions => ({ ...o, headers: { ...(o.headers ?? {}), cookie } });

    const created = await app.inject(
      authed({ method: 'POST', url: '/api/users', payload: { username: 'bob', password: 'bobpassword' } }),
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('password_hash');
    const bobId = created.json().id;

    const list = await app.inject(authed({ method: 'GET', url: '/api/users' }));
    expect(list.json().map((u: { username: string }) => u.username).sort()).toEqual([TEST_USER, 'bob'].sort());

    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'bobpassword' } }))
        .statusCode,
    ).toBe(200);

    const pw = await app.inject(
      authed({ method: 'POST', url: `/api/users/${bobId}/password`, payload: { password: 'newbobpassword' } }),
    );
    expect(pw.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'newbobpassword' } })
      ).statusCode,
    ).toBe(200);

    expect((await app.inject(authed({ method: 'DELETE', url: `/api/users/${bobId}` }))).statusCode).toBe(200);

    // Cannot delete the last remaining user.
    const meId = (await app.inject(authed({ method: 'GET', url: '/api/me' }))).json().user.id;
    expect((await app.inject(authed({ method: 'DELETE', url: `/api/users/${meId}` }))).statusCode).toBe(400);

    await app.close();
  });

  it('rejects a too-short password (400)', async () => {
    const { app } = await makeApp();
    const cookie = await loginCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'shorty', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
