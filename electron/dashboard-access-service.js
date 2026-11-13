const SUPER_ADMIN_EMAIL = 'goldenhandcaregivers@gmail.com';
const DASHBOARD_ROLE = 'SUPPLIER_ADMIN';
const ALLOWED_PERMISSIONS = Object.freeze([
  'overview',
  'caregivers',
  'liveMap',
]);

function cleanString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeDashboardUserRequest(request = {}) {
  const uid = cleanString(request.uid, 128);
  const name = cleanString(request.name, 100);
  const email = cleanString(request.email, 320).toLowerCase();
  const password = typeof request.password === 'string' ? request.password : '';
  const enabled = request.enabled !== false;
  const permissions = {};
  for (const permission of ALLOWED_PERMISSIONS) {
    permissions[permission] = request.permissions?.[permission] === true;
  }
  const caregiverIds = [...new Set((Array.isArray(request.caregiverIds) ? request.caregiverIds : [])
    .map((value) => cleanString(value, 128))
    .filter(Boolean))].slice(0, 500);

  if (!name) throw new Error('Enter a name for the dashboard user.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
  if (email === SUPER_ADMIN_EMAIL) throw new Error('The protected main administrator account cannot be changed here.');
  if (!uid && password.length < 6) throw new Error('A new dashboard user needs a password with at least 6 characters.');
  if (password && password.length < 6) throw new Error('The password must contain at least 6 characters.');
  if (!Object.values(permissions).some(Boolean)) throw new Error('Select at least one dashboard permission.');
  if (!caregiverIds.length) throw new Error('Assign at least one caregiver or nurse.');

  return { uid, name, email, password, enabled, permissions, caregiverIds };
}

async function saveDashboardUser({ auth, db, administrator, request }) {
  const input = normalizeDashboardUserRequest(request);
  let uid = input.uid;
  let createdAuthUser = false;

  try {
    const caregiverDocuments = await db.getAll(...input.caregiverIds.map((caregiverId) => db.collection('users').doc(caregiverId)));
    const invalidCaregiver = caregiverDocuments.find((entry) => {
      if (!entry.exists) return true;
      const role = entry.data()?.role;
      return role !== 'CAREGIVER' && role !== 'NURSE';
    });
    if (invalidCaregiver) {
      throw new Error('One or more assigned staff records are missing or are not caregivers or nurses. Refresh the list and try again.');
    }

    if (uid) {
      const existing = await auth.getUser(uid);
      if ((existing.email || '').toLowerCase() === SUPER_ADMIN_EMAIL) {
        throw new Error('The protected main administrator account cannot be changed here.');
      }
      const update = {
        email: input.email,
        displayName: input.name,
        emailVerified: true,
        disabled: !input.enabled,
      };
      if (input.password) update.password = input.password;
      await auth.updateUser(uid, update);
    } else {
      const created = await auth.createUser({
        email: input.email,
        password: input.password,
        displayName: input.name,
        emailVerified: true,
        disabled: !input.enabled,
      });
      uid = created.uid;
      createdAuthUser = true;
    }

    const authUser = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, {
      ...(authUser.customClaims || {}),
      dashboardRole: DASHBOARD_ROLE,
    });

    const now = Date.now();
    const userRef = db.collection('admin_users').doc(uid);
    const previous = await userRef.get();
    await userRef.set({
      uid,
      name: input.name,
      email: input.email,
      role: DASHBOARD_ROLE,
      enabled: input.enabled,
      permissions: input.permissions,
      caregiverIds: input.caregiverIds,
      createdAt: previous.exists ? (previous.data().createdAt || now) : now,
      createdBy: previous.exists ? (previous.data().createdBy || administrator.uid) : administrator.uid,
      updatedAt: now,
      updatedBy: administrator.uid,
    }, { merge: true });

    await db.collection('admin_audit_logs').add({
      action: createdAuthUser ? 'SUPPLIER_ADMIN_CREATED' : 'SUPPLIER_ADMIN_UPDATED',
      targetUid: uid,
      targetEmail: input.email,
      actorUid: administrator.uid,
      actorEmail: administrator.email || SUPER_ADMIN_EMAIL,
      timestamp: now,
    });

    if (!input.enabled) await auth.revokeRefreshTokens(uid);
    return { uid, created: createdAuthUser };
  } catch (error) {
    if (createdAuthUser && uid) {
      await auth.deleteUser(uid).catch(() => {});
    }
    throw error;
  }
}

async function listDashboardUsers({ auth, db }) {
  const snapshot = await db.collection('admin_users').orderBy('name').get();
  const records = snapshot.docs.map((entry) => ({ uid: entry.id, ...entry.data() }));
  if (!records.length) return [];

  const result = await auth.getUsers(records.map((record) => ({ uid: record.uid })));
  const authByUid = new Map(result.users.map((user) => [user.uid, user]));
  return records.map((record) => {
    const authUser = authByUid.get(record.uid);
    return {
      ...record,
      email: authUser?.email || record.email || '',
      name: authUser?.displayName || record.name || '',
      enabled: authUser ? !authUser.disabled && record.enabled !== false : false,
      authAccountMissing: !authUser,
    };
  });
}

module.exports = {
  ALLOWED_PERMISSIONS,
  DASHBOARD_ROLE,
  SUPER_ADMIN_EMAIL,
  listDashboardUsers,
  normalizeDashboardUserRequest,
  saveDashboardUser,
};
