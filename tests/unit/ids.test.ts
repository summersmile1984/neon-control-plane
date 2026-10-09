import { describe, expect, it } from 'vitest';
import {
  generateBranchId, generateEndpointId, generateHexId, generateOperationId, generateProjectId,
  isBranchId, isEndpointId, isHexId, isProjectId,
} from '../../src/domain/ids.ts';

/**
 * These patterns are what client libraries validate against (002 §4):
 * an id that fails them is silently dropped by the consumer, so they are part of the contract.
 */
const CONSUMER_PROJECT = /^[a-z0-9-]{1,60}$/;
const CONSUMER_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONSUMER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

describe('identifier generation', () => {
  it('project ids match the project pattern', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = generateProjectId();
      expect(id, id).toMatch(CONSUMER_PROJECT);
      expect(isProjectId(id)).toBe(true);
      expect(id.split('-')).toHaveLength(3);
    }
  });

  it('branch ids are br-prefixed and match the branch pattern', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = generateBranchId();
      expect(id, id).toMatch(/^br-/);
      expect(id, id).toMatch(CONSUMER_BRANCH);
      expect(isBranchId(id)).toBe(true);
    }
  });

  it('endpoint ids are ep-prefixed and match the endpoint identifier pattern', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = generateEndpointId();
      expect(id, id).toMatch(/^ep-/);
      expect(id, id).toMatch(CONSUMER_IDENTIFIER);
      expect(isEndpointId(id)).toBe(true);
    }
  });

  it('pageserver ids are 32 lowercase hex characters', () => {
    const id = generateHexId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isHexId(id)).toBe(true);
  });

  it('operation ids are UUIDs, as the spec types them', () => {
    expect(generateOperationId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not collide across a small batch', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateBranchId()));
    expect(ids.size).toBe(500);
  });
});
