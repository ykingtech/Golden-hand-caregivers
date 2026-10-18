const { FieldValue } = require('firebase-admin/firestore');

const ADMIN_EMAIL = 'goldenhandadmin@gmail.com';

async function deleteMatching(db, collectionName, field, value) {
  const snapshot = await db.collection(collectionName).where(field, '==', value).get();
  if (snapshot.empty) return 0;
  const writer = db.bulkWriter();
  snapshot.docs.forEach((item) => writer.delete(item.ref));
  await writer.close();
  return snapshot.size;
}

async function deleteUserCompletely({ auth, db, realtimeDb, uid, adminUid }) {
  if (!uid || typeof uid !== 'string') throw new Error('A target user ID is required.');
  if (uid === adminUid) throw new Error('You cannot delete your own administrator account.');

  let target = null;
  try {
    target = await auth.getUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }
  if (target?.email?.toLowerCase() === ADMIN_EMAIL || target?.customClaims?.admin === true) {
    throw new Error('Protected administrator accounts cannot be deleted.');
  }

  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (userSnapshot.exists && userSnapshot.get('accountDeletionStatus') !== 'DELETING') {
    await userRef.update({
      accountDeletionStatus: 'DELETING',
      accountDeletionStartedAt: FieldValue.serverTimestamp(),
    });
  }

  if (target) {
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  }

  const bookingIds = new Set();
  for (const field of ['clientId', 'caregiverId']) {
    const linked = await db.collection('bookings').where(field, '==', uid).get();
    linked.docs.forEach((item) => bookingIds.add(item.id));
  }

  const linkedCounts = {
    alerts: 0,
    chats: 0,
    careLogs: 0,
    reviews: 0,
    complaints: 0,
    chatReports: 0,
  };
  for (const bookingId of bookingIds) {
    linkedCounts.alerts += await deleteMatching(db, 'alerts', 'bookingId', bookingId);
    linkedCounts.chats += await deleteMatching(db, 'chats', 'bookingId', bookingId);
    linkedCounts.careLogs += await deleteMatching(db, 'care_logs', 'bookingId', bookingId);
    linkedCounts.reviews += await deleteMatching(db, 'reviews', 'bookingId', bookingId);
    linkedCounts.complaints += await deleteMatching(db, 'complaints', 'bookingId', bookingId);
    linkedCounts.chatReports += await deleteMatching(db, 'chat_reports', 'bookingId', bookingId);
  }

  const bookingWriter = db.bulkWriter();
  for (const bookingId of bookingIds) {
    bookingWriter.delete(db.collection('bookings').doc(bookingId));
    bookingWriter.delete(db.collection('public_jobs').doc(bookingId));
  }
  await bookingWriter.close();

  const counts = {};
  const directDeletes = [
    ['transactions', 'userId'],
    ['withdrawal_requests', 'uid'],
    ['wallet_top_ups', 'uid'],
    ['leave_requests', 'caregiverId'],
    ['elders', 'clientId'],
    ['elder_profiles', 'clientId'],
    ['sos_alerts', 'userId'],
    ['reviews', 'caregiverId'],
    ['reviews', 'clientId'],
    ['alerts', 'userId'],
    ['chats', 'senderId'],
    ['care_logs', 'caregiverId'],
    ['complaints', 'clientId'],
    ['complaints', 'caregiverId'],
    ['chat_reports', 'reporterId'],
    ['chat_reports', 'reportedUserId'],
  ];
  for (const [collectionName, field] of directDeletes) {
    const key = `${collectionName}.${field}`;
    counts[key] = await deleteMatching(db, collectionName, field, uid);
  }

  const plans = await db.collection('subscription_plans').where('assignedCaregivers', 'array-contains', uid).get();
  for (const plan of plans.docs) {
    await plan.ref.update({ assignedCaregivers: FieldValue.arrayRemove(uid) });
  }

  const favorites = await db.collection('users').where('favoriteCaregivers', 'array-contains', uid).get();
  for (const favoriteOwner of favorites.docs) {
    await favoriteOwner.ref.update({ favoriteCaregivers: FieldValue.arrayRemove(uid) });
  }

  await db.recursiveDelete(userRef);
  await Promise.all([
    db.recursiveDelete(db.collection('public_profiles').doc(uid)),
    db.recursiveDelete(db.collection('live_locations').doc(uid)),
    realtimeDb.ref(`locations/${uid}`).remove(),
  ]);

  if (target) await auth.deleteUser(uid);

  return {
    ok: true,
    deletedAuthAccount: Boolean(target),
    deletedBookings: bookingIds.size,
    linkedCounts,
    directCounts: counts,
    updatedSubscriptionPlans: plans.size,
    updatedFavoriteLists: favorites.size,
  };
}

module.exports = { ADMIN_EMAIL, deleteUserCompletely };
