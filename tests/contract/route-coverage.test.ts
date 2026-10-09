import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every route the control plane registers must be exercised by at least one test, in a tier CI runs.
 *
 * This file exists because the audit behind it found six implemented routes with no test at all
 * (branch update, database read/update, the project endpoint collection, endpoint restart and
 * `/projects/shared`), plus a misnamed test that claimed to cover restart while never calling it.
 * A route can be implemented and broken for months without noticing, so the check is mechanical:
 * read the route table out of src/http, read every request out of tests/, and compare.
 *
 * Scope, stated plainly: this proves a test *references* each path with that verb. It does not prove
 * the assertions are good — that is what the tests themselves are for. Dynamic registrations
 * (`/cplane/*`, the two paths the cplane router builds) are listed explicitly below.
 */

const ROUTES_DIR = fileURLToPath(new URL('../../src/http/routes/', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Registered in a loop rather than as literals; asserted by cplane-shape.test.ts. */
const DYNAMIC_ROUTES = ['/cplane/get_endpoint_access_control', '/cplane/wake_compute'];

interface ImplementedRoute {
  readonly verb: string;
  readonly path: string;
  readonly file: string;
}

function implementedRoutes(): ImplementedRoute[] {
  const found: ImplementedRoute[] = [];
  for (const name of readdirSync(ROUTES_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(ROUTES_DIR, name), 'utf8');
    for (const match of text.matchAll(/\b(?:api|app|console)\.(get|post|patch|delete)\(\s*'([^']+)'/g)) {
      found.push({ verb: match[1]!.toUpperCase(), path: match[2]!, file: name });
    }
  }
  return found;
}

function testSources(): { file: string; text: string }[] {
  const files: { file: string; text: string }[] = [];
  for (const tier of ['unit', 'contract', 'e2e', 'browser']) {
    for (const name of readdirSync(join(TESTS_DIR, tier))) {
      if (!name.endsWith('.ts')) continue;
      files.push({ file: `${tier}/${name}`, text: readFileSync(join(TESTS_DIR, tier, name), 'utf8') });
    }
  }
  return files;
}

const segments = (path: string): string[] => path.split('?')[0]!.split('/').filter(Boolean);

/** A route template matches a request path when each `:param` lines up with one concrete segment. */
function matches(routePath: string, requestPath: string): boolean {
  const route = segments(routePath);
  const request = segments(requestPath);
  const path = request[0] === 'api' && request[1] === 'v2' ? request.slice(2) : request;
  if (route.length !== path.length) return false;
  return route.every((part, index) => part.startsWith(':') || part === path[index]);
}

const CALL = /\b(app\.request|api|fetch|get|post|patch|delete|del|put|page\.goto|page\.request\.(?:get|post|patch|delete|put))\(\s*[`'"]([^`'"]+)[`'"]/g;
const VERB_HELPERS: Record<string, string> = {
  get: 'GET', post: 'POST', patch: 'PATCH', delete: 'DELETE', del: 'DELETE', put: 'PUT',
};

function referencedPaths(): { verb: string; path: string; file: string }[] {
  const seen: { verb: string; path: string; file: string }[] = [];
  for (const { file, text } of testSources()) {
    const normalised = text.replaceAll(/\$\{[^}]*\}/g, '@');
    const calls = [...normalised.matchAll(CALL)].filter((call) => call[2]!.startsWith('/'));
    for (const [index, call] of calls.entries()) {
      const helper = call[1]!.split('.').at(-1)!;
      let verb: string;
      if (helper in VERB_HELPERS) verb = VERB_HELPERS[helper]!;
      else if (call[1] === 'page.goto') verb = 'GET';
      else {
        // Only this call's own argument block; the next request's method must not leak in.
        const stop = calls[index + 1]?.index ?? call.index! + 400;
        const method = /method:\s*'(\w+)'/.exec(normalised.slice(call.index! + call[0].length, stop));
        verb = method?.[1]?.toUpperCase() ?? 'GET';
      }
      seen.push({ verb, path: call[2]!, file });
    }
  }
  return seen;
}

const routes = implementedRoutes();
const referenced = referencedPaths();

describe('route coverage', () => {
  it('finds the route table', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(referenced.length).toBeGreaterThan(100);
  });

  it.each(routes.map((route) => [`${route.verb} ${route.path}`, route] as const))(
    '%s is exercised by a test',
    (_label, route) => {
      const covered = referenced.some((hit) => hit.verb === route.verb && matches(route.path, hit.path));
      expect(
        covered,
        `${route.verb} ${route.path} (${route.file}) has no test calling it. Add a case, or drop the route.`,
      ).toBe(true);
    },
  );

  it.each(DYNAMIC_ROUTES)('%s is covered by cplane-shape.test.ts', (path) => {
    const covered = referenced.some((hit) => matches(path, hit.path));
    expect(covered, `${path} is registered in a loop and must stay covered by the cplane suite`).toBe(true);
  });
});
