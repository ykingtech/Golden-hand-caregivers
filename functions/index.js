const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getDatabaseWithUrl } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const crypto = require('crypto');

initializeApp();
const auth = getAuth();
const db = getFirestore();
const REGION = 'asia-south1';
const ADMIN_EMAIL = 'goldenhandadmin@gmail.com';
const REALTIME_DATABASE_URL = 'https://care-2a20d-default-rtdb.asia-southeast1.firebasedatabase.app';
const PUBLIC_PROFILE_FIELDS = [
  'name', 'role', 'profileImageUrl', 'isVerified', 'isBusy', 'rating',
  'reviewCount', 'hourlyRate', 'gender', 'categories', 'experienceYears',
  'specialSkills', 'qualifications', 'preferredServiceTypes',
  'preferredDistricts', 'onLeaveDates',
];

function publicProfileFrom(user) {
  const profile = {};
  for (const field of PUBLIC_PROFILE_FIELDS) {
    if (user[field] !== undefined) profile[field] = user[field];
  }
  profile.updatedAt = FieldValue.serverTimestamp();
  return profile;
}

function publicJobFrom(booking) {
  return {
    status: booking.status,
    requestedTime: booking.requestedTime || 0,
    scheduledTime: booking.scheduledTime || 0,
    estimatedHours: booking.estimatedHours || 0,
    careCategory: booking.careCategory || '',
    serviceType: booking.serviceType || '',
    durationType: booking.durationType || '',
    isEmergency: booking.isEmergency === true,
    isSubscriptionBooking: booking.isSubscriptionBooking === true,
    planName: booking.planName || '',
    allowedCaregivers: Array.isArray(booking.allowedCaregivers) ? booking.allowedCaregivers : [],
    address: 'Location details are shared after acceptance.',
    elderId: 'Care request',
    clientId: '',
    caregiverId: null,
    locationLat: 0,
    locationLng: 0,
    requestedTasks: [],
    jobDescription: '',
    updatedAt: FieldValue.serverTimestamp(),
  };
}

exports.syncPublicJob = onDocumentWritten({
  region: REGION,
  document: 'bookings/{bookingId}',
}, async (event) => {
  const after = event.data?.after;
  const ref = db.collection('public_jobs').doc(event.params.bookingId);
  if (!after?.exists) return ref.delete().catch((error) => { if (error.code !== 5) throw error; });
  const booking = after.data();
  if (!['PENDING', 'BROADCASTED'].includes(booking.status) || booking.caregiverId) {
    return ref.delete().catch((error) => { if (error.code !== 5) throw error; });
  }
  await ref.set(publicJobFrom(booking));
});

exports.syncPublicProfile = onDocumentWritten({
  region: REGION,
  document: 'users/{uid}',
}, async (event) => {
  const after = event.data?.after;
  const ref = db.collection('public_profiles').doc(event.params.uid);
  if (!after?.exists) {
    await ref.delete().catch((error) => {
      if (error.code !== 5) throw error;
    });
    return;
  }
  await ref.set(publicProfileFrom(after.data()), { merge: true });
});

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
}

async function deleteMatching(collectionName, field, value) {
  const snapshot = await db.collection(collectionName).where(field, '==', value).get();
  if (snapshot.empty) return 0;
  const writer = db.bulkWriter();
  snapshot.docs.forEach((item) => writer.delete(item.ref));
  await writer.close();
  return snapshot.size;
}

exports.ensureAdminAccess = onCall({ region: REGION }, async (request) => {
  const email = (request.auth?.token.email || '').toLowerCase();
  if (!request.auth || !request.auth.token.email_verified || email !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the verified designated admin can bootstrap admin access.');
  }
  const user = await auth.getUser(request.auth.uid);
  await auth.setCustomUserClaims(user.uid, { ...user.customClaims, admin: true });
  return { ok: true };
});

exports.backfillPublicProfiles = onCall({ region: REGION, timeoutSeconds: 540 }, async (request) => {
  requireAdmin(request);
  const migrationRef = db.collection('settings').doc('_publicProfilesMigrationV1');
  if ((await migrationRef.get()).exists) return { processed: 0, done: true, alreadyComplete: true };
  const pageSize = 300;
  let processed = 0;
  let cursorDoc = null;
  while (true) {
    let query = db.collection('users').orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursorDoc) query = query.startAfter(cursorDoc);
    const page = await query.get();
    if (page.empty) break;
    const batch = db.batch();
    for (const userDoc of page.docs) {
      batch.set(db.collection('public_profiles').doc(userDoc.id), publicProfileFrom(userDoc.data()), { merge: true });
    }
    await batch.commit();
    processed += page.size;
    cursorDoc = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }
  let bookingCursor = null;
  while (true) {
    let query = db.collection('bookings').orderBy(FieldPath.documentId()).limit(pageSize);
    if (bookingCursor) query = query.startAfter(bookingCursor);
    const page = await query.get();
    if (page.empty) break;
    const batch = db.batch();
    let hasPublicJobs = false;
    for (const bookingDoc of page.docs) {
      const booking = bookingDoc.data();
      if (['PENDING', 'BROADCASTED'].includes(booking.status) && !booking.caregiverId) {
        batch.set(db.collection('public_jobs').doc(bookingDoc.id), publicJobFrom(booking));
        hasPublicJobs = true;
      }
    }
    if (hasPublicJobs) await batch.commit();
    bookingCursor = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }
  await migrationRef.set({ completedAt: FieldValue.serverTimestamp(), processed });
  return { processed, done: true };
});

exports.respondToOpenJob = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in is required.');
  const uid = request.auth.uid;
  const bookingId = typeof request.data?.bookingId === 'string' ? request.data.bookingId.trim() : '';
  const action = request.data?.action;
  if (!bookingId || !['accept', 'reject'].includes(action)) {
    throw new HttpsError('invalid-argument', 'A booking ID and valid action are required.');
  }
  const userDoc = await db.collection('users').doc(uid).get();
  const user = userDoc.data() || {};
  if (!['CAREGIVER', 'NURSE'].includes(user.role) || !(user.isVerified === true || user.kycStatus === 'APPROVED')) {
    throw new HttpsError('permission-denied', 'A verified caregiver account is required.');
  }
  const bookingRef = db.collection('bookings').doc(bookingId);
  const rate = Number(request.data?.hourlyRate);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : Number(user.hourlyRate || 0);
  const code = `${String.fromCharCode(65 + crypto.randomInt(0, 26))}${crypto.randomInt(0, 10000).toString().padStart(4, '0')}`;
  await db.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists) throw new HttpsError('not-found', 'Job is no longer available.');
    const booking = bookingSnap.data();
    if (!['PENDING', 'BROADCASTED'].includes(booking.status) || booking.caregiverId) {
      throw new HttpsError('failed-precondition', 'This job has already been assigned.');
    }
    if (Array.isArray(booking.allowedCaregivers) && booking.allowedCaregivers.length && !booking.allowedCaregivers.includes(uid)) {
      throw new HttpsError('permission-denied', 'This job is not available to your account.');
    }
    if (Array.isArray(booking.rejectedBy) && booking.rejectedBy.includes(uid)) {
      throw new HttpsError('failed-precondition', 'You have already skipped this job.');
    }
    if (action === 'reject') {
      transaction.set(db.collection('users').doc(uid).collection('dismissed_jobs').doc(bookingId), {
        dismissedAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    const acceptedAt = Date.now();
    transaction.update(bookingRef, {
      caregiverId: uid,
      status: 'ACCEPTED',
      startCode: code,
      hourlyRate: safeRate,
      acceptedAt,
      appliedCaregivers: FieldValue.arrayUnion(uid),
      jobAcceptances: [{ caregiverId: uid, acceptedAt, acceptanceOrder: 0, isPrimary: true, confirmationStatus: 'PENDING' }],
    });
    transaction.set(db.collection('public_profiles').doc(uid), { isBusy: true }, { merge: true });
  });
  return { ok: true, action };
});

exports.deleteUserCompletely = onCall({ region: REGION, timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  requireAdmin(request);
  const databaseUrl = REALTIME_DATABASE_URL;
  const uid = typeof request.data?.uid === 'string' ? request.data.uid.trim() : '';
  if (!uid) throw new HttpsError('invalid-argument', 'A target user ID is required.');
  if (uid === request.auth.uid) throw new HttpsError('failed-precondition', 'You cannot delete your own account.');

  let target;
  try {
    target = await auth.getUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
  }
  if (target?.email?.toLowerCase() === ADMIN_EMAIL || target?.customClaims?.admin === true) {
    throw new HttpsError('failed-precondition', 'Protected administrator accounts cannot be deleted using this tool.');
  }

  // Notify installed clients first. Their authenticated profile listener signs
  // them out immediately while the remaining cleanup is still in progress.
  const userRef = db.collection('users').doc(uid);
  const userSnapshot = await userRef.get();
  if (userSnapshot.exists && userSnapshot.get('accountDeletionStatus') !== 'DELETING') {
    await userRef.update({
      accountDeletionStatus: 'DELETING',
      accountDeletionStartedAt: FieldValue.serverTimestamp(),
    });
  }

  // Disable and revoke sessions next. Auth deletion is last so a cleanup
  // failure is retryable by an administrator.
  if (target) {
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  }

  const bookingIds = new Set();
  for (const field of ['clientId', 'caregiverId']) {
    const linked = await db.collection('bookings').where(field, '==', uid).get();
    linked.docs.forEach((item) => bookingIds.add(item.id));
  }
  let removedAlerts = 0;
  let removedChats = 0;
  let removedCareLogs = 0;
  let removedReviews = 0;
  let removedComplaints = 0;
  let removedChatReports = 0;
  for (const bookingId of bookingIds) {
    removedAlerts += await deleteMatching('alerts', 'bookingId', bookingId);
    removedChats += await deleteMatching('chats', 'bookingId', bookingId);
    removedCareLogs += await deleteMatching('care_logs', 'bookingId', bookingId);
    removedReviews += await deleteMatching('reviews', 'bookingId', bookingId);
    removedComplaints += await deleteMatching('complaints', 'bookingId', bookingId);
    removedChatReports += await deleteMatching('chat_reports', 'bookingId', bookingId);
  }
  const bookingWriter = db.bulkWriter();
  for (const bookingId of bookingIds) bookingWriter.delete(db.collection('bookings').doc(bookingId));
  await bookingWriter.close();

  const [
    transactions,
    withdrawalRequests,
    walletTopUps,
    leaveRequests,
    elderProfiles,
    legacyElderProfiles,
    sosAlerts,
    userReviews,
  ] = await Promise.all([
    deleteMatching('transactions', 'userId', uid),
    deleteMatching('withdrawal_requests', 'uid', uid),
    deleteMatching('wallet_top_ups', 'uid', uid),
    deleteMatching('leave_requests', 'caregiverId', uid),
    deleteMatching('elders', 'clientId', uid),
    deleteMatching('elder_profiles', 'clientId', uid),
    deleteMatching('sos_alerts', 'userId', uid),
    deleteMatching('reviews', 'caregiverId', uid),
  ]);
  const clientReviews = await deleteMatching('reviews', 'clientId', uid);
  removedComplaints += await deleteMatching('complaints', 'clientId', uid);
  removedComplaints += await deleteMatching('complaints', 'caregiverId', uid);
  removedChatReports += await deleteMatching('chat_reports', 'reporterId', uid);
  removedChatReports += await deleteMatching('chat_reports', 'reportedUserId', uid);
  const [directAlerts, directChats, directCareLogs] = await Promise.all([
    deleteMatching('alerts', 'userId', uid),
    deleteMatching('chats', 'senderId', uid),
    deleteMatching('care_logs', 'caregiverId', uid),
  ]);

  const plans = await db.collection('subscription_plans').where('assignedCaregivers', 'array-contains', uid).get();
  for (const plan of plans.docs) {
    await plan.ref.update({ assignedCaregivers: FieldValue.arrayRemove(uid) });
  }

  const favorites = await db.collection('users').where('favoriteCaregivers', 'array-contains', uid).get();
  for (const favoriteOwner of favorites.docs) {
    await favoriteOwner.ref.update({ favoriteCaregivers: FieldValue.arrayRemove(uid) });
  }

  // recursiveDelete removes the user document and all nested collections (e.g. investments).
  await db.recursiveDelete(userRef);
  await Promise.all([
    db.recursiveDelete(db.collection('public_profiles').doc(uid)),
    db.recursiveDelete(db.collection('live_locations').doc(uid)),
    getDatabaseWithUrl(databaseUrl).ref(`locations/${uid}`).remove(),
  ]);
  if (target) await auth.deleteUser(uid);

  return {
    ok: true,
    deletedAuthAccount: Boolean(target),
    deletedUserTree: true,
    deletedBookings: bookingIds.size,
    deletedAlerts: removedAlerts + directAlerts,
    deletedChats: removedChats + directChats,
    deletedCareLogs: removedCareLogs + directCareLogs,
    deletedReviews: removedReviews + userReviews + clientReviews,
    deletedElderProfiles: elderProfiles + legacyElderProfiles,
    deletedSosAlerts: sosAlerts,
    deletedTransactions: transactions,
    deletedWithdrawalRequests: withdrawalRequests,
    deletedWalletTopUps: walletTopUps,
    deletedLeaveRequests: leaveRequests,
    deletedComplaints: removedComplaints,
    deletedChatReports: removedChatReports,
    updatedSubscriptionPlans: plans.size,
    updatedFavoriteLists: favorites.size,
  };
});
