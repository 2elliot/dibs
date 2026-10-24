import { expect, test, type Page } from '@playwright/test';

type Row = Record<string, unknown>;
type Feed = {
  update(table: string, rows: Row[]): void;
  connection: { uri: string; dbName: string };
  subscribed: string[];
};
declare global { interface Window { dashboardFeed: Feed } }

const lobby = (id: number, state: string) => ({ id, state, scenario: `Lobby ${id}`, mode: 'dibs' });
const event = (id: number) => ({ id, lobbyId: id, actor: `actor-${id}`, type: 'lobby_started', atUs: 1000 });

// Exercise the real config loader, live source, and React panels with a
// deterministic client transport. Only the network/database boundary is faked.
async function livePage(page: Page, config: Row, rows: Record<string, Row[]>, query = '') {
  await page.route('**/config.json', route => route.fulfill({ json: config }));
  await page.route(/\/packages\/client\/src\/index\.ts(?:\?.*)?$/, route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const rows = ${JSON.stringify(rows)};
      const names = ['lobby', 'participant', 'plan', 'planItem', 'message', 'job', 'proposal', 'response', 'contract', 'delivery', 'event', 'head', 'verification', 'review', 'service'];
      const connections = new Set();
      export const tables = Object.fromEntries(names.map(name => [name, name]));
      export const toJson = row => row;
      const feed = window.dashboardFeed = {
        connection: {}, subscribed: [],
        update(table, updated) { rows[table] = updated; connections.forEach(listeners => listeners.forEach(listener => listener())); },
      };
      function makeConnection() {
      const listeners = new Set();
      connections.add(listeners);
      return {
        db: Object.fromEntries(names.map(name => [name, {
          iter: () => feed.subscribed.includes(name) ? rows[name] || [] : [],
          onInsert: fn => listeners.add(fn), onDelete: fn => listeners.add(fn), onUpdate: fn => listeners.add(fn),
        }])),
        subscriptionBuilder() {
          let applied;
          return {
            onApplied(fn) { applied = fn; return this; },
            onError() { return this; },
            subscribe(selected) {
              feed.subscribed = selected;
              queueMicrotask(() => applied());
              return { unsubscribe() {} };
            },
          };
        },
        disconnect() { listeners.clear(); connections.delete(listeners); },
      };
      }
      export async function connect(options) { feed.connection = options; return { conn: makeConnection() }; }
      export async function subscribeLobby() { feed.subscribed = names; }
    `,
  }));
  await page.goto(`/${query}`);
}

test('worker DibsConfig follows the newest running lobby and scopes rows after switching', async ({ page }) => {
  await livePage(page, { dbUri: 'http://worker-db:3000', dbName: 'worker-db' }, {
    // Deliberately unsorted: a higher setup/verified ID must not beat running.
    lobby: [lobby(9, 'verified'), lobby(4, 'running'), lobby(2, 'running')],
    event: [event(2), event(4), event(9)],
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 4');
  await expect(page.locator('.timeline-list')).toContainText('actor-4');
  await expect(page.locator('.timeline-entry')).toHaveCount(1);
  expect(await page.evaluate(() => window.dashboardFeed.connection)).toEqual({ uri: 'http://worker-db:3000', dbName: 'worker-db' });
  await expect(page.getByText('REPLAY', { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    window.dashboardFeed.update('event', [{ id: 10, lobbyId: 10, actor: 'actor-10', type: 'lobby_started', atUs: 2000 }]);
    window.dashboardFeed.update('lobby', [
      { id: 10, state: 'setup', scenario: 'Lobby 10', mode: 'dibs' },
      { id: 4, state: 'running', scenario: 'Lobby 4', mode: 'dibs' },
    ]);
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 4');
  // State changes as well as inserts must trigger selection.
  await page.evaluate(() => window.dashboardFeed.update('lobby', [
    { id: 4, state: 'running', scenario: 'Lobby 4', mode: 'dibs' },
    { id: 10, state: 'running', scenario: 'Lobby 10', mode: 'dibs' },
  ]));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 10');
  await expect(page.locator('.timeline-list')).toContainText('actor-10');
  await expect(page.locator('.timeline-list')).not.toContainText('actor-4');
  await page.evaluate(() => window.dashboardFeed.update('lobby', [
    { id: 4, state: 'verified', scenario: 'Lobby 4', mode: 'dibs' },
    { id: 12, state: 'stopped', scenario: 'Lobby 12', mode: 'dibs' },
    { id: 10, state: 'verified', scenario: 'Lobby 10', mode: 'dibs' },
  ]));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 12');
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('automatic selection waits for the first lobby and follows newer inserts', async ({ page }) => {
  await livePage(page, { dbUri: 'http://worker-db:3000', dbName: 'worker-db' }, {});
  await expect.poll(() => page.evaluate(() => window.dashboardFeed?.subscribed.length)).toBeGreaterThan(0);
  for (const id of [1, 3]) {
    await page.evaluate(row => window.dashboardFeed.update('lobby', [row]), lobby(id, 'running'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Lobby ${id}`);
  }
  await page.evaluate(() => window.dashboardFeed.update('lobby', []));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('dibs lobby');
});

test('legacy config pins its lobby even when a newer running lobby appears', async ({ page }) => {
  await livePage(page, { uri: 'http://legacy-db:3000', db: 'legacy-db', lobby: 2 }, {
    lobby: [lobby(2, 'verified'), lobby(9, 'running')],
  });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 2');
  expect(await page.evaluate(() => window.dashboardFeed.connection)).toEqual({ uri: 'http://legacy-db:3000', dbName: 'legacy-db' });
  await page.evaluate(() => window.dashboardFeed.update('lobby', [
    { id: 2, state: 'verified', scenario: 'Lobby 2', mode: 'dibs' },
    { id: 12, state: 'running', scenario: 'Lobby 12', mode: 'dibs' },
  ]));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 2');
});

test('query parameters override the worker config and pin the requested lobby', async ({ page }) => {
  await livePage(page, { dbUri: 'http://worker-db:3000', dbName: 'worker-db' }, {
    lobby: [lobby(1, 'stopped'), lobby(9, 'running')],
  }, '?uri=http%3A%2F%2Foverride-db%3A3000&db=override-db&lobby=1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobby 1');
  expect(await page.evaluate(() => window.dashboardFeed.connection)).toEqual({ uri: 'http://override-db:3000', dbName: 'override-db' });
});
