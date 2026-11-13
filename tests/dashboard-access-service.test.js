const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDashboardUserRequest } = require('../electron/dashboard-access-service');

function validRequest(overrides = {}) {
  return {
    name: 'Supplier Manager',
    email: 'supplier@example.com',
    password: 'secure-password',
    enabled: true,
    permissions: { overview: true, caregivers: true, liveMap: true },
    caregiverIds: ['caregiver-1'],
    ...overrides,
  };
}

test('normalizes restricted dashboard access and removes duplicate staff IDs', () => {
  const normalized = normalizeDashboardUserRequest(validRequest({
    email: '  SUPPLIER@example.com ',
    caregiverIds: ['caregiver-1', 'caregiver-1', 'nurse-2'],
    permissions: { overview: true, caregivers: false, liveMap: true, settings: true },
  }));

  assert.equal(normalized.email, 'supplier@example.com');
  assert.deepEqual(normalized.caregiverIds, ['caregiver-1', 'nurse-2']);
  assert.deepEqual(normalized.permissions, { overview: true, caregivers: false, liveMap: true });
});

test('allows an existing restricted user to keep the current password', () => {
  const normalized = normalizeDashboardUserRequest(validRequest({ uid: 'supplier-uid', password: '' }));
  assert.equal(normalized.uid, 'supplier-uid');
  assert.equal(normalized.password, '');
});

test('requires permissions, assigned staff, and a secure initial password', () => {
  assert.throws(
    () => normalizeDashboardUserRequest(validRequest({ permissions: {} })),
    /at least one dashboard permission/i,
  );
  assert.throws(
    () => normalizeDashboardUserRequest(validRequest({ caregiverIds: [] })),
    /at least one caregiver or nurse/i,
  );
  assert.throws(
    () => normalizeDashboardUserRequest(validRequest({ password: '12345' })),
    /at least 6 characters/i,
  );
});

test('protects the main administrator account', () => {
  assert.throws(
    () => normalizeDashboardUserRequest(validRequest({ email: 'goldenhandcaregivers@gmail.com' })),
    /protected main administrator/i,
  );
});
