import 'server-only';
import { adminDb } from '@/lib/firebase/admin.core';
import { SUBCOLLECTIONS } from '@/lib/firebase/collections';
import type { VisibilityRelationship, VisibilityViewer } from './visibility';

/** Resolve follow relationships for profile owners in two document reads per target. */
export async function visibilityRelationshipsFor(
  targetIds: string[],
  viewer: VisibilityViewer,
): Promise<Map<string, VisibilityRelationship>> {
  const ids = [...new Set(targetIds)].filter((id) => id && id !== viewer?.id);
  const relationships = new Map<string, VisibilityRelationship>();
  if (!viewer?.id || ids.length === 0) return relationships;

  const db = adminDb();
  const references = ids.flatMap((id) => [
    db.collection(SUBCOLLECTIONS.userFollowing(viewer.id)).doc(id),
    db.collection(SUBCOLLECTIONS.userFollowing(id)).doc(viewer.id),
  ]);
  const snapshots: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let offset = 0; offset < references.length; offset += 100) {
    snapshots.push(...(await db.getAll(...references.slice(offset, offset + 100))));
  }
  ids.forEach((id, index) => {
    const follows = snapshots[index * 2].exists;
    const followsBack = snapshots[index * 2 + 1].exists;
    relationships.set(id, follows && followsBack ? 'MUTUAL' : follows ? 'FOLLOWING' : 'NONE');
  });
  return relationships;
}
