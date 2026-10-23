import { createServer, request, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArchMapApp, type ArchMapApp } from '../src/index.js';

const shop = join(dirname(fileURLToPath(import.meta.url)), '../examples/shop');
let app: ArchMapApp;
let server: Server;
let base = '';

beforeAll(async () => {
  app = createArchMapApp({ root: shop, watch: false });
  server = createServer(app.handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  base = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  app.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
};

describe('serve', () => {
  it('serves the page and the model summary', async () => {
    expect((await get('/')).body).toContain('mountGraph');
    const model = JSON.parse((await get('/api/model')).body);
    expect(model.counts).toEqual({ packages: 7, dependencies: 11, externals: 4, errors: 5, warnings: 1 });
    const forbidden = model.violations.find((v: { rule: string; file: string }) => v.rule === 'forbidden' && v.file.startsWith('apps/api'));
    expect(forbidden.target).toEqual({ page: 'components', pkg: '@shop/api', node: 'cmp:@shop/api:src/routes' });
  });

  it('lays out every view', async () => {
    for (const name of ['context', 'containers', 'packages']) {
      const view = JSON.parse((await get(`/api/view?name=${name}`)).body);
      expect(view.svg, name).toMatch(/^<svg class="diagram"/);
    }
    const components = JSON.parse((await get('/api/view?name=components&pkg=%40shop%2Fapi')).body);
    expect(components.svg).toContain('data-id="cmp:@shop/api:src/routes"');
    expect(components.svg).toMatch(/class="edge edge-violation" data-from="cmp:@shop\/api:src\/routes" data-to="pkg:@shop\/db"/);
    expect(components.details['cmp:@shop/api:src/routes']).toContain('apps/api/src/routes/payments.ts');
    expect((await get('/api/view?name=components&pkg=nope')).status).toBe(404);
  });

  it('only answers local hosts', async () => {
    const status = await new Promise<number>((done) => {
      request(base + '/api/model', { headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(403);
  });

  it('reports no change when nothing changed', () => {
    expect(app.rebuild()).toBe(false);
  });
});
